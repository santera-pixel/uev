#include "UEVGraphBehaviorTree.h"

#include "UEVGraphAI.h"
#include "UEVGraphShared.h"

#include "AIGraph.h"
#include "AIGraphNode.h"
#include "AIGraphTypes.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "BehaviorTree/BTCompositeNode.h"
#include "BehaviorTree/BTDecorator.h"
#include "BehaviorTree/BTNode.h"
#include "BehaviorTree/BTService.h"
#include "BehaviorTree/BTTaskNode.h"
#include "BehaviorTree/BehaviorTree.h"
#include "BehaviorTree/BlackboardData.h"
#include "BehaviorTree/Composites/BTComposite_SimpleParallel.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "EdGraph/EdGraphPin.h"
#include "EdGraph/EdGraphSchema.h"
#include "Editor.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Misc/PackageName.h"
#include "ScopedTransaction.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "UObject/Package.h"
#include "UObject/UnrealType.h"

namespace UEVGraphBT
{
	namespace
	{
		// ------------------------------------------------------------------
		// Engine class paths. BehaviorTreeEditor exports none of these classes,
		// so they are resolved by path and driven through their exported bases.
		// ------------------------------------------------------------------
		const TCHAR* const GraphClassPath = TEXT("/Script/BehaviorTreeEditor.BehaviorTreeGraph");
		const TCHAR* const SchemaClassPath = TEXT("/Script/BehaviorTreeEditor.EdGraphSchema_BehaviorTree");
		const TCHAR* const CompositeGraphNodeClassPath = TEXT("/Script/BehaviorTreeEditor.BehaviorTreeGraphNode_Composite");
		const TCHAR* const SimpleParallelGraphNodeClassPath = TEXT("/Script/BehaviorTreeEditor.BehaviorTreeGraphNode_SimpleParallel");
		const TCHAR* const TaskGraphNodeClassPath = TEXT("/Script/BehaviorTreeEditor.BehaviorTreeGraphNode_Task");
		const TCHAR* const ServiceGraphNodeClassPath = TEXT("/Script/BehaviorTreeEditor.BehaviorTreeGraphNode_Service");
		const TCHAR* const DecoratorGraphNodeClassPath = TEXT("/Script/BehaviorTreeEditor.BehaviorTreeGraphNode_Decorator");

		const TCHAR* const RootGraphNodeClassName = TEXT("BehaviorTreeGraphNode_Root");

		/** CreateBTFromGraph sorts each output pin's links by NodePosX, so sibling X is the order. */
		const int32 SiblingSpacing = 400;
		const int32 DepthSpacing = 180;

		struct FGraphBinding
		{
			UBehaviorTree* Tree = nullptr;
			UAIGraph* Graph = nullptr;
			UAIGraphNode* RootGraphNode = nullptr;
		};

		struct FNodeEntry
		{
			FString Id;
			FString ParentId;
			const UBTNode* Instance = nullptr;
			int32 Index = 0;
			int32 Depth = 0;
			int32 ExecutionIndex = INDEX_NONE;
			FString Kind;
			FString ClassPath;
			FString ClassName;
			FString InstanceName;
			FString GraphNodeId;
			FString GraphClassName;
			TArray<FString> DecoratorIds;
			TArray<FString> ServiceIds;
			TArray<FString> ChildIds;
		};

		struct FSubNodeEntry
		{
			FString Id;
			FString OwnerId;
			const UBTNode* Instance = nullptr;
			int32 Index = 0;
			FString Kind;
			FString ClassPath;
			FString ClassName;
			FString InstanceName;
			FString GraphNodeId;
		};

		struct FWalkState
		{
			TArray<FNodeEntry> Entries;
			TArray<FSubNodeEntry> SubNodes;
			TArray<FString> Warnings;
			TSet<FString> UsedIds;
			int32 MaxExecutionIndex = 0;
			int32 MaxDepth = 0;
		};

		struct FResolvedNode
		{
			/** Runtime node instance; null for the visual root graph node. */
			UBTNode* Instance = nullptr;
			/** Graph node that owns the instance (the root graph node for "root"). */
			UAIGraphNode* GraphNode = nullptr;
			FString Id;
			FString Kind;
			int32 ExecutionIndex = INDEX_NONE;
		};

		struct FScopedGraphLock
		{
			UAIGraph* Graph = nullptr;
			explicit FScopedGraphLock(UAIGraph* InGraph) : Graph(InGraph)
			{
				if (Graph)
				{
					Graph->LockUpdates();
				}
			}
			~FScopedGraphLock()
			{
				if (Graph)
				{
					Graph->UnlockUpdates();
				}
			}
		};

		struct FScopedEditorTransaction
		{
			TUniquePtr<FScopedTransaction> Transaction;
			explicit FScopedEditorTransaction(const FString& Label)
			{
				if (GEditor)
				{
					Transaction = MakeUnique<FScopedTransaction>(FText::FromString(Label));
				}
			}
		};

		// ------------------------------------------------------------------
		// Small helpers
		// ------------------------------------------------------------------
		UClass* LoadClassPath(const TCHAR* ClassPath)
		{
			return ClassPath ? LoadObject<UClass>(nullptr, ClassPath) : nullptr;
		}

		FString ClassNameOf(const UObject* Object)
		{
			return (Object && Object->GetClass()) ? Object->GetClass()->GetName() : FString();
		}

		FString ClassPathOf(const UObject* Object)
		{
			return (Object && Object->GetClass()) ? Object->GetClass()->GetPathName() : FString();
		}

		bool IsRootGraphNode(const UEdGraphNode* Node)
		{
			return Node && Node->GetClass() && Node->GetClass()->GetName() == RootGraphNodeClassName;
		}

		UEdGraphPin* DirectionalPin(UEdGraphNode* Node, EEdGraphPinDirection Direction, int32 Index = 0)
		{
			if (!Node)
			{
				return nullptr;
			}
			int32 Seen = 0;
			for (UEdGraphPin* Pin : Node->Pins)
			{
				if (!Pin || Pin->Direction != Direction)
				{
					continue;
				}
				if (Seen == Index)
				{
					return Pin;
				}
				++Seen;
			}
			return nullptr;
		}

		/** Read an object-pointer TArray property by name (Decorators/Services are not exported API). */
		void AppendObjectArrayProperty(const UObject* Owner, const FName& PropertyName, TArray<UObject*>& Out)
		{
			if (!Owner)
			{
				return;
			}
			FArrayProperty* ArrayProperty = FindFProperty<FArrayProperty>(Owner->GetClass(), PropertyName);
			if (!ArrayProperty)
			{
				return;
			}
			FObjectPropertyBase* Inner = CastField<FObjectPropertyBase>(ArrayProperty->Inner);
			if (!Inner)
			{
				return;
			}
			FScriptArrayHelper Helper(ArrayProperty, ArrayProperty->ContainerPtrToValuePtr<void>(const_cast<UObject*>(Owner)));
			for (int32 Index = 0; Index < Helper.Num(); ++Index)
			{
				if (UObject* Value = Inner->GetObjectPropertyValue(Helper.GetRawPtr(Index)))
				{
					Out.Add(Value);
				}
			}
		}

		FString NodeIdOfExecutionIndex(int32 ExecutionIndex)
		{
			return FString::Printf(TEXT("ei:%d"), ExecutionIndex);
		}

		FString SubNodeId(const FString& OwnerId, TCHAR Marker, int32 Index)
		{
			return FString::Printf(TEXT("%s/%c%d"), *OwnerId, Marker, Index);
		}

		/** Split "ei:3/d1" into base "ei:3", marker 'd', index 1. */
		bool SplitSubNodeId(const FString& Id, FString& OutBase, TCHAR& OutMarker, int32& OutIndex)
		{
			OutBase = Id;
			OutMarker = TEXT('\0');
			OutIndex = INDEX_NONE;
			int32 SlashIndex = INDEX_NONE;
			if (!Id.FindChar(TEXT('/'), SlashIndex) || SlashIndex <= 0 || !Id.IsValidIndex(SlashIndex + 1))
			{
				return false;
			}
			const TCHAR Marker = Id[SlashIndex + 1];
			if (Marker != TEXT('d') && Marker != TEXT('s'))
			{
				return false;
			}
			const FString IndexText = Id.Mid(SlashIndex + 2);
			if (IndexText.IsEmpty() || !IndexText.IsNumeric())
			{
				return false;
			}
			OutBase = Id.Left(SlashIndex);
			OutMarker = Marker;
			OutIndex = FCString::Atoi(*IndexText);
			return OutIndex >= 0;
		}

		TArray<TSharedPtr<FJsonValue>> MakeStringArray(const TArray<FString>& Values)
		{
			TArray<TSharedPtr<FJsonValue>> Result;
			for (const FString& Value : Values)
			{
				Result.Add(MakeShared<FJsonValueString>(Value));
			}
			return Result;
		}

		// Deliberately not named MakeError: Unreal's ValueOrError.h defines a global MakeError
		// template that would win overload resolution for FString arguments.
		FJsonObjectPtr MakeFailure(const FString& Message)
		{
			return UEVGraph::MakeErrorObject(Message);
		}

		FJsonObjectPtr PieGuard(const FString& Action)
		{
			int32 PieWorldCount = 0;
			if (UEVGraph::IsPlayInEditorActive(PieWorldCount) && !UEVGraph::UnsafeOperationsAllowed())
			{
				return UEVGraph::MakeGuardRefusal(
					TEXT("pie-editor-mutation"),
					TEXT("Refuse editor-world mutations while Play In Editor is running"),
					FString::Printf(TEXT("Refusing to %s: Play In Editor is running (%d PIE world(s))."), *Action, PieWorldCount),
					TEXT("Stop Play In Editor first, then retry. Set UEV_ALLOW_UNSAFE_OPERATIONS=1 only for a deliberate, backed-up operation."));
			}
			return FJsonObjectPtr();
		}

		// ------------------------------------------------------------------
		// Graph creation and binding
		// ------------------------------------------------------------------
		FString UniqueGraphName(UBehaviorTree* Tree)
		{
			const FString Desired = TEXT("Behavior Tree");
			if (Tree && !FindObject<UEdGraph>(Tree, *Desired))
			{
				return Desired;
			}
			return FString::Printf(TEXT("%s_%s"), *Desired, *FGuid::NewGuid().ToString(EGuidFormats::Digits));
		}

		UAIGraphNode* FindRootGraphNode(UAIGraph* Graph)
		{
			if (!Graph)
			{
				return nullptr;
			}
			for (UEdGraphNode* Node : Graph->Nodes)
			{
				if (IsRootGraphNode(Node))
				{
					return Cast<UAIGraphNode>(Node);
				}
			}
			return nullptr;
		}

		UAIGraphNode* RootCompositeGraphNode(UAIGraphNode* RootGraphNode)
		{
			if (!RootGraphNode)
			{
				return nullptr;
			}
			UEdGraphPin* Pin = DirectionalPin(RootGraphNode, EGPD_Output, 0);
			if (!Pin || Pin->LinkedTo.Num() == 0)
			{
				return nullptr;
			}
			return Cast<UAIGraphNode>(Pin->LinkedTo[0] ? Pin->LinkedTo[0]->GetOwningNode() : nullptr);
		}

		void CollectGraphNodeAndSubNodes(UAIGraphNode* Node, TArray<UAIGraphNode*>& Out)
		{
			if (!Node)
			{
				return;
			}
			Out.Add(Node);
			for (UAIGraphNode* SubNode : Node->SubNodes)
			{
				CollectGraphNodeAndSubNodes(SubNode, Out);
			}
		}

		void CollectAllGraphNodes(UAIGraph* Graph, TArray<UAIGraphNode*>& Out)
		{
			if (!Graph)
			{
				return;
			}
			for (UEdGraphNode* Node : Graph->Nodes)
			{
				CollectGraphNodeAndSubNodes(Cast<UAIGraphNode>(Node), Out);
			}
		}

		/**
		 * Node instances spawned by this module live inside the editor graph (SpawnGraphNode passes the
		 * graph as the outer). The engine re-parents the instances it adopts into the behavior tree asset,
		 * but the compiled root node keeps the graph as its outer, so discarding a graph has to hand every
		 * instance still owned by it to the asset first. Renaming the graph into the transient package with
		 * instances inside it drops those objects from the package and leaves the asset with a null root.
		 */
		int32 ReparentGraphInstancesIntoAsset(UEdGraph* Graph, UObject* NewOuter)
		{
			if (!Graph || !NewOuter)
			{
				return 0;
			}
			TArray<UAIGraphNode*> All;
			CollectAllGraphNodes(Cast<UAIGraph>(Graph), All);
			int32 Moved = 0;
			for (UAIGraphNode* GraphNode : All)
			{
				UObject* Instance = GraphNode ? GraphNode->NodeInstance : nullptr;
				if (!Instance)
				{
					continue;
				}
				bool bOwnedByGraph = false;
				for (UObject* Outer = Instance->GetOuter(); Outer; Outer = Outer->GetOuter())
				{
					if (Outer == Graph)
					{
						bOwnedByGraph = true;
						break;
					}
				}
				if (bOwnedByGraph)
				{
					Instance->Rename(nullptr, NewOuter, REN_DontCreateRedirectors | REN_NonTransactional);
					++Moved;
				}
			}
			return Moved;
		}

		TArray<UAIGraphNode*> ReflectedSubNodes(UAIGraphNode* Node, const FName& PropertyName)
		{
			TArray<UAIGraphNode*> Result;
			TArray<UObject*> Objects;
			AppendObjectArrayProperty(Node, PropertyName, Objects);
			for (UObject* Object : Objects)
			{
				if (UAIGraphNode* SubNode = Cast<UAIGraphNode>(Object))
				{
					Result.Add(SubNode);
				}
			}
			return Result;
		}

		TArray<UAIGraphNode*> DecoratorSubNodes(UAIGraphNode* Node)
		{
			return ReflectedSubNodes(Node, TEXT("Decorators"));
		}

		TArray<UAIGraphNode*> ServiceSubNodes(UAIGraphNode* Node)
		{
			return ReflectedSubNodes(Node, TEXT("Services"));
		}

		/** CreateBTFromGraph sorts each output pin by NodePosX, so X is the child order. */
		TArray<UAIGraphNode*> OrderedChildren(UAIGraphNode* Node)
		{
			TArray<UAIGraphNode*> Children;
			UEdGraphPin* Pin = Node ? DirectionalPin(Node, EGPD_Output, 0) : nullptr;
			if (!Pin)
			{
				return Children;
			}
			for (UEdGraphPin* Link : Pin->LinkedTo)
			{
				if (UAIGraphNode* Child = Cast<UAIGraphNode>(Link ? Link->GetOwningNode() : nullptr))
				{
					Children.Add(Child);
				}
			}
			Children.Sort([](const UAIGraphNode& Left, const UAIGraphNode& Right)
			{
				if (Left.NodePosX != Right.NodePosX)
				{
					return Left.NodePosX < Right.NodePosX;
				}
				return Left.GetName() < Right.GetName();
			});
			return Children;
		}

		UAIGraphNode* FindParentGraphNode(UAIGraph* Graph, UAIGraphNode* Target)
		{
			if (!Graph || !Target)
			{
				return nullptr;
			}
			TArray<UAIGraphNode*> All;
			CollectAllGraphNodes(Graph, All);
			for (UAIGraphNode* Candidate : All)
			{
				UEdGraphPin* Pin = DirectionalPin(Candidate, EGPD_Output, 0);
				if (!Pin)
				{
					continue;
				}
				for (UEdGraphPin* Link : Pin->LinkedTo)
				{
					if (Link && Link->GetOwningNode() == Target)
					{
						return Candidate;
					}
				}
			}
			return nullptr;
		}

		bool CreateBehaviorTreeGraph(FGraphBinding& Binding, FString& OutError)
		{
			UBehaviorTree* Tree = Binding.Tree;
			if (!Tree)
			{
				OutError = TEXT("No behavior tree asset was loaded.");
				return false;
			}
			UClass* GraphClass = LoadClassPath(GraphClassPath);
			UClass* SchemaClass = LoadClassPath(SchemaClassPath);
			if (!GraphClass || !SchemaClass)
			{
				OutError = TEXT("The behavior tree editor graph classes are unavailable. Load the BehaviorTreeEditor module in this editor build and retry.");
				return false;
			}
			Tree->Modify();
			// Detach any stale graph so CreateNewGraph cannot trip its same-name ensure. Instances that
			// still belong to the old graph (notably the compiled root node) must move into the asset
			// first: they would otherwise leave the package with the graph and come back as null.
			if (UEdGraph* Stale = Tree->BTGraph)
			{
				ReparentGraphInstancesIntoAsset(Stale, Tree);
				Tree->BTGraph = nullptr;
				Stale->Rename(nullptr, GetTransientPackage(), REN_DontCreateRedirectors | REN_NonTransactional | REN_ForceNoResetLoaders);
			}
			UEdGraph* NewGraph = FBlueprintEditorUtils::CreateNewGraph(Tree, FName(*UniqueGraphName(Tree)), GraphClass, SchemaClass);
			if (!NewGraph)
			{
				OutError = TEXT("Could not create the behavior tree graph.");
				return false;
			}
			UAIGraph* AIGraph = Cast<UAIGraph>(NewGraph);
			if (!AIGraph)
			{
				OutError = TEXT("The behavior tree graph class does not derive from UAIGraph.");
				return false;
			}
			Tree->BTGraph = NewGraph;
			const UEdGraphSchema* Schema = NewGraph->GetSchema();
			if (!Schema)
			{
				OutError = TEXT("The behavior tree graph has no schema.");
				return false;
			}
			// OnCreated() calls SpawnMissingNodes(), which mirrors RootNode into the graph and links the
			// root pin last, so the intermediate UpdateAsset() calls cannot disturb the runtime tree.
			Schema->CreateDefaultNodesForGraph(*NewGraph);
			AIGraph->OnCreated();
			AIGraph->Initialize();
			Binding.Graph = AIGraph;
			Binding.RootGraphNode = FindRootGraphNode(AIGraph);
			if (!Binding.RootGraphNode)
			{
				OutError = TEXT("The behavior tree graph was created without a root node.");
				return false;
			}
			return true;
		}

		bool BindGraph(UBehaviorTree* Tree, FGraphBinding& Binding, FString& OutError)
		{
			Binding.Tree = Tree;
			Binding.Graph = Tree ? Cast<UAIGraph>(Tree->BTGraph) : nullptr;
			if (!Binding.Graph)
			{
				return CreateBehaviorTreeGraph(Binding, OutError);
			}
			Binding.RootGraphNode = FindRootGraphNode(Binding.Graph);
			if (!Binding.RootGraphNode)
			{
				return CreateBehaviorTreeGraph(Binding, OutError);
			}
			return true;
		}

		// ------------------------------------------------------------------
		// Graph node creation / removal / linking
		// ------------------------------------------------------------------
		UAIGraphNode* SpawnGraphNode(FGraphBinding& Binding, UClass* InstanceClass, UClass* GraphNodeClass, FString& OutError)
		{
			if (!Binding.Graph || !GraphNodeClass || !InstanceClass)
			{
				OutError = TEXT("Could not resolve the behavior tree graph node class.");
				return nullptr;
			}
			UAIGraphNode* Node = NewObject<UAIGraphNode>(Binding.Graph, GraphNodeClass);
			if (!Node)
			{
				OutError = FString::Printf(TEXT("Could not create a graph node of class %s."), *GraphNodeClass->GetName());
				return nullptr;
			}
			Node->SetFlags(RF_Transactional);
			// Pre-seeding NodeInstance keeps PostPlacedNewNode from instantiating the default class.
			Node->NodeInstance = NewObject<UObject>(Binding.Graph, InstanceClass);
			if (!Node->NodeInstance)
			{
				OutError = FString::Printf(TEXT("Could not create an instance of %s."), *InstanceClass->GetName());
				return nullptr;
			}
			Node->NodeInstance->SetFlags(RF_Transactional);
			Binding.Graph->AddNode(Node, false, false);
			Node->CreateNewGuid();
			Node->AllocateDefaultPins();
			Node->InitializeInstance();
			if (UBTNode* Instance = Cast<UBTNode>(Node->NodeInstance))
			{
				Instance->InitializeFromAsset(*Binding.Tree);
			}
			return Node;
		}

		UAIGraphNode* SpawnSubGraphNode(FGraphBinding& Binding, UAIGraphNode* Parent, UClass* InstanceClass, UClass* GraphNodeClass, FString& OutError)
		{
			if (!Parent || !Binding.Graph || !GraphNodeClass || !InstanceClass)
			{
				OutError = TEXT("Could not resolve the behavior tree sub-node class.");
				return nullptr;
			}
			UAIGraphNode* Node = NewObject<UAIGraphNode>(Binding.Graph, GraphNodeClass);
			if (!Node)
			{
				OutError = FString::Printf(TEXT("Could not create a sub-node of class %s."), *GraphNodeClass->GetName());
				return nullptr;
			}
			Node->SetFlags(RF_Transactional);
			Node->NodeInstance = NewObject<UObject>(Binding.Graph, InstanceClass);
			if (!Node->NodeInstance)
			{
				OutError = FString::Printf(TEXT("Could not create an instance of %s."), *InstanceClass->GetName());
				return nullptr;
			}
			Node->NodeInstance->SetFlags(RF_Transactional);
			// AddSubNode owns parenting, guid, pins and OnSubNodeAdded bookkeeping.
			Parent->AddSubNode(Node, Binding.Graph);
			if (UBTNode* Instance = Cast<UBTNode>(Node->NodeInstance))
			{
				Instance->InitializeFromAsset(*Binding.Tree);
			}
			return Node;
		}

		void DestroyGraphNodeRecursive(FGraphBinding& Binding, UAIGraphNode* Node)
		{
			if (!Node)
			{
				return;
			}
			const TArray<UAIGraphNode*> SubNodes = Node->SubNodes;
			for (UAIGraphNode* SubNode : SubNodes)
			{
				DestroyGraphNodeRecursive(Binding, SubNode);
			}
			if (Node->Pins.Num() > 0)
			{
				Node->BreakAllNodeLinks();
			}
			if (Binding.Graph)
			{
				Binding.Graph->RemoveNode(Node, true);
			}
		}

		bool LinkChild(FGraphBinding& Binding, UAIGraphNode* Parent, UAIGraphNode* Child, FString& OutError)
		{
			UEdGraphPin* ParentPin = DirectionalPin(Parent, EGPD_Output, 0);
			UEdGraphPin* ChildPin = DirectionalPin(Child, EGPD_Input, 0);
			if (!ParentPin)
			{
				OutError = TEXT("The parent node has no output pin, so it cannot take children.");
				return false;
			}
			if (!ChildPin)
			{
				OutError = TEXT("The child node has no input pin.");
				return false;
			}
			const UEdGraphSchema* Schema = Binding.Graph ? Binding.Graph->GetSchema() : nullptr;
			if (!Schema)
			{
				OutError = TEXT("The behavior tree graph has no schema.");
				return false;
			}
			if (!Schema->TryCreateConnection(ParentPin, ChildPin))
			{
				OutError = TEXT("The behavior tree graph schema refused the connection; the child may already be parented or the connection would create a cycle.");
				return false;
			}
			return true;
		}

		bool OrderChildAt(UAIGraphNode* Parent, UAIGraphNode* Child, int32 Index, FString& OutError)
		{
			TArray<UAIGraphNode*> Children = OrderedChildren(Parent);
			const int32 Current = Children.IndexOfByKey(Child);
			if (Current == INDEX_NONE)
			{
				OutError = TEXT("The node is not a child of the requested parent.");
				return false;
			}
			if (Index < 0)
			{
				Index = 0;
			}
			if (Index >= Children.Num())
			{
				Index = Children.Num() - 1;
			}
			if (Index == Current)
			{
				return true;
			}
			Children.RemoveAt(Current);
			Children.Insert(Child, Index);
			for (int32 Slot = 0; Slot < Children.Num(); ++Slot)
			{
				Children[Slot]->NodePosX = Slot * SiblingSpacing;
			}
			return true;
		}

		bool ReorderSubNodeArray(UAIGraphNode* Owner, const FName& PropertyName, UAIGraphNode* SubNode, int32 Index)
		{
			if (!Owner || !SubNode)
			{
				return false;
			}
			FArrayProperty* ArrayProperty = FindFProperty<FArrayProperty>(Owner->GetClass(), PropertyName);
			if (!ArrayProperty)
			{
				return false;
			}
			FObjectPropertyBase* Inner = CastField<FObjectPropertyBase>(ArrayProperty->Inner);
			if (!Inner)
			{
				return false;
			}
			FScriptArrayHelper Helper(ArrayProperty, ArrayProperty->ContainerPtrToValuePtr<void>(Owner));
			TArray<UObject*> Items;
			for (int32 Slot = 0; Slot < Helper.Num(); ++Slot)
			{
				Items.Add(Inner->GetObjectPropertyValue(Helper.GetRawPtr(Slot)));
			}
			const int32 Current = Items.IndexOfByKey(SubNode);
			if (Current == INDEX_NONE)
			{
				return false;
			}
			if (Index < 0)
			{
				Index = 0;
			}
			if (Index >= Items.Num())
			{
				Index = Items.Num() - 1;
			}
			Items.RemoveAt(Current);
			Items.Insert(SubNode, Index);
			for (int32 Slot = 0; Slot < Items.Num() && Slot < Helper.Num(); ++Slot)
			{
				Inner->SetObjectPropertyValue(Helper.GetRawPtr(Slot), Items[Slot]);
			}
			return true;
		}

		// ------------------------------------------------------------------
		// Layout
		// ------------------------------------------------------------------
		void LayoutChildren(UAIGraphNode* Node, int32 Depth, int32& NextIndex)
		{
			for (UAIGraphNode* Child : OrderedChildren(Node))
			{
				Child->NodePosX = NextIndex * SiblingSpacing;
				Child->NodePosY = Depth * DepthSpacing;
				++NextIndex;
				if (DirectionalPin(Child, EGPD_Output, 0))
				{
					LayoutChildren(Child, Depth + 1, NextIndex);
				}
			}
		}

		void LayoutGraph(FGraphBinding& Binding)
		{
			if (!Binding.Graph)
			{
				return;
			}
			if (UAIGraphNode* RootComposite = RootCompositeGraphNode(Binding.RootGraphNode))
			{
				int32 NextIndex = 0;
				RootComposite->NodePosX = NextIndex * SiblingSpacing;
				RootComposite->NodePosY = 0;
				++NextIndex;
				LayoutChildren(RootComposite, 1, NextIndex);
			}
			if (Binding.RootGraphNode)
			{
				Binding.RootGraphNode->NodePosX = -SiblingSpacing;
				Binding.RootGraphNode->NodePosY = 0;
			}
		}

		// ------------------------------------------------------------------
		// Runtime-tree walking
		// ------------------------------------------------------------------
		void CollectServiceInstances(const UBTNode* Node, TArray<UBTNode*>& Out)
		{
			TArray<UObject*> Objects;
			AppendObjectArrayProperty(Node, TEXT("Services"), Objects);
			for (UObject* Object : Objects)
			{
				if (UBTNode* Service = Cast<UBTNode>(Object))
				{
					Out.Add(Service);
				}
			}
		}

		void CollectTreeNodes(UBTNode* Node, TArray<UBTNode*>& Out, TSet<const UBTNode*>& Seen)
		{
			if (!Node || Seen.Contains(Node))
			{
				return;
			}
			Seen.Add(Node);
			Out.Add(Node);
			if (UBTCompositeNode* Composite = Cast<UBTCompositeNode>(Node))
			{
				for (const FBTCompositeChild& Child : Composite->Children)
				{
					for (UBTDecorator* Decorator : Child.Decorators)
					{
						CollectTreeNodes(Decorator, Out, Seen);
					}
					if (Child.ChildComposite)
					{
						CollectTreeNodes(Child.ChildComposite, Out, Seen);
					}
					else if (Child.ChildTask)
					{
						CollectTreeNodes(Child.ChildTask, Out, Seen);
					}
				}
			}
			TArray<UBTNode*> Services;
			CollectServiceInstances(Node, Services);
			for (UBTNode* Service : Services)
			{
				CollectTreeNodes(Service, Out, Seen);
			}
		}

		void CollectAllTreeNodes(UBehaviorTree* Tree, TArray<UBTNode*>& Out)
		{
			if (!Tree)
			{
				return;
			}
			TSet<const UBTNode*> Seen;
			for (UBTDecorator* Decorator : Tree->RootDecorators)
			{
				CollectTreeNodes(Decorator, Out, Seen);
			}
			CollectTreeNodes(Tree->RootNode, Out, Seen);
		}

		void BuildGraphInstanceMap(UAIGraph* Graph, TMap<const UBTNode*, UAIGraphNode*>& Out)
		{
			TArray<UAIGraphNode*> All;
			CollectAllGraphNodes(Graph, All);
			for (UAIGraphNode* GraphNode : All)
			{
				if (UBTNode* Instance = Cast<UBTNode>(GraphNode->NodeInstance))
				{
					Out.Add(Instance, GraphNode);
				}
			}
		}

		void WalkNode(
			UBTNode* Node,
			const TArray<UBTDecorator*>& Decorators,
			int32 ChildIndex,
			const FString& ParentId,
			int32 Depth,
			const TMap<const UBTNode*, UAIGraphNode*>& GraphNodeByInstance,
			FWalkState& State)
		{
			if (!Node)
			{
				return;
			}
			if (Depth >= 64)
			{
				State.Warnings.Add(TEXT("The tree is deeper than 64 levels; the remaining nodes were not described."));
				return;
			}

			FNodeEntry Entry;
			const int32 RawExecutionIndex = static_cast<int32>(Node->GetExecutionIndex());
			Entry.ExecutionIndex = RawExecutionIndex >= MAX_uint16 ? INDEX_NONE : RawExecutionIndex;
			Entry.Id = Entry.ExecutionIndex >= 0
				? NodeIdOfExecutionIndex(Entry.ExecutionIndex)
				: FString::Printf(TEXT("node:%s"), *Node->GetName());
			if (State.UsedIds.Contains(Entry.Id))
			{
				State.Warnings.Add(FString::Printf(TEXT("Two nodes report execution index %d; the second was given a distinct id."), Entry.ExecutionIndex));
				Entry.Id = FString::Printf(TEXT("%s~%d"), *Entry.Id, State.Entries.Num());
			}
			State.UsedIds.Add(Entry.Id);
			Entry.ParentId = ParentId;
			Entry.Instance = Node;
			Entry.Index = ChildIndex;
			Entry.Depth = Depth;
			Entry.Kind = Cast<UBTCompositeNode>(Node) ? TEXT("composite") : TEXT("task");
			Entry.ClassPath = ClassPathOf(Node);
			Entry.ClassName = ClassNameOf(Node);
			Entry.InstanceName = Node->GetName();
			if (UAIGraphNode* GraphNode = GraphNodeByInstance.FindRef(Node))
			{
				Entry.GraphNodeId = UEVGraph::NodeId(GraphNode);
				Entry.GraphClassName = ClassNameOf(GraphNode);
			}

			for (int32 Index = 0; Index < Decorators.Num(); ++Index)
			{
				UBTDecorator* Decorator = Decorators[Index];
				if (!Decorator)
				{
					continue;
				}
				const FString DecoratorId = SubNodeId(Entry.Id, TEXT('d'), Index);
				Entry.DecoratorIds.Add(DecoratorId);
				FSubNodeEntry Sub;
				Sub.Id = DecoratorId;
				Sub.OwnerId = Entry.Id;
				Sub.Index = Index;
				Sub.Kind = TEXT("decorator");
				Sub.Instance = Decorator;
				Sub.ClassPath = ClassPathOf(Decorator);
				Sub.ClassName = ClassNameOf(Decorator);
				Sub.InstanceName = Decorator->GetName();
				if (UAIGraphNode* GraphNode = GraphNodeByInstance.FindRef(Decorator))
				{
					Sub.GraphNodeId = UEVGraph::NodeId(GraphNode);
				}
				State.SubNodes.Add(Sub);
				State.MaxExecutionIndex = FMath::Max(State.MaxExecutionIndex, static_cast<int32>(Decorator->GetExecutionIndex()));
			}

			TArray<UBTNode*> Services;
			CollectServiceInstances(Node, Services);
			for (int32 Index = 0; Index < Services.Num(); ++Index)
			{
				UBTNode* Service = Services[Index];
				const FString ServiceId = SubNodeId(Entry.Id, TEXT('s'), Index);
				Entry.ServiceIds.Add(ServiceId);
				FSubNodeEntry Sub;
				Sub.Id = ServiceId;
				Sub.OwnerId = Entry.Id;
				Sub.Index = Index;
				Sub.Kind = TEXT("service");
				Sub.Instance = Service;
				Sub.ClassPath = ClassPathOf(Service);
				Sub.ClassName = ClassNameOf(Service);
				Sub.InstanceName = Service->GetName();
				if (UAIGraphNode* GraphNode = GraphNodeByInstance.FindRef(Service))
				{
					Sub.GraphNodeId = UEVGraph::NodeId(GraphNode);
				}
				State.SubNodes.Add(Sub);
				State.MaxExecutionIndex = FMath::Max(State.MaxExecutionIndex, static_cast<int32>(Service->GetExecutionIndex()));
			}

			State.MaxExecutionIndex = FMath::Max(State.MaxExecutionIndex, Entry.ExecutionIndex);
			State.MaxDepth = FMath::Max(State.MaxDepth, Depth);
			const int32 EntryIndex = State.Entries.Add(Entry);

			if (UBTCompositeNode* Composite = Cast<UBTCompositeNode>(Node))
			{
				for (int32 Index = 0; Index < Composite->Children.Num(); ++Index)
				{
					const FBTCompositeChild& Child = Composite->Children[Index];
					UBTNode* ChildNode = Child.ChildComposite ? static_cast<UBTNode*>(Child.ChildComposite) : static_cast<UBTNode*>(Child.ChildTask);
					if (!ChildNode)
					{
						State.Warnings.Add(FString::Printf(TEXT("%s has an empty child slot %d."), *Entry.Id, Index));
						continue;
					}
					const int32 Before = State.Entries.Num();
					WalkNode(ChildNode, Child.Decorators, Index, State.Entries[EntryIndex].Id, Depth + 1, GraphNodeByInstance, State);
					if (State.Entries.IsValidIndex(Before))
					{
						State.Entries[EntryIndex].ChildIds.Add(State.Entries[Before].Id);
					}
				}
			}
		}

		FJsonObjectPtr EntryToJson(const FNodeEntry& Entry)
		{
			FJsonObjectPtr Object = UEVGraph::MakeObject();
			Object->SetStringField(TEXT("id"), Entry.Id);
			Object->SetStringField(TEXT("parent_id"), Entry.ParentId);
			Object->SetNumberField(TEXT("index"), Entry.Index);
			Object->SetNumberField(TEXT("depth"), Entry.Depth);
			Object->SetNumberField(TEXT("execution_index"), Entry.ExecutionIndex);
			Object->SetStringField(TEXT("kind"), Entry.Kind);
			Object->SetStringField(TEXT("class"), Entry.ClassPath);
			Object->SetStringField(TEXT("class_name"), Entry.ClassName);
			Object->SetStringField(TEXT("name"), Entry.InstanceName);
			Object->SetStringField(TEXT("graph_node_id"), Entry.GraphNodeId);
			Object->SetStringField(TEXT("graph_node_class"), Entry.GraphClassName);
			Object->SetArrayField(TEXT("decorator_ids"), MakeStringArray(Entry.DecoratorIds));
			Object->SetArrayField(TEXT("service_ids"), MakeStringArray(Entry.ServiceIds));
			Object->SetArrayField(TEXT("child_ids"), MakeStringArray(Entry.ChildIds));
			return Object;
		}

		FJsonObjectPtr SubNodeToJson(const FSubNodeEntry& Entry)
		{
			FJsonObjectPtr Object = UEVGraph::MakeObject();
			Object->SetStringField(TEXT("id"), Entry.Id);
			Object->SetStringField(TEXT("owner_id"), Entry.OwnerId);
			Object->SetNumberField(TEXT("index"), Entry.Index);
			Object->SetStringField(TEXT("kind"), Entry.Kind);
			Object->SetStringField(TEXT("class"), Entry.ClassPath);
			Object->SetStringField(TEXT("class_name"), Entry.ClassName);
			Object->SetStringField(TEXT("name"), Entry.InstanceName);
			Object->SetStringField(TEXT("graph_node_id"), Entry.GraphNodeId);
			return Object;
		}

		int32 ReadIntProperty(const UObject* Object, const FName& PropertyName, int32 DefaultValue = INDEX_NONE)
		{
			if (!Object)
			{
				return DefaultValue;
			}
			if (FIntProperty* Property = FindFProperty<FIntProperty>(Object->GetClass(), PropertyName))
			{
				return Property->GetPropertyValue_InContainer(Object);
			}
			return DefaultValue;
		}

		void VerifyGraphTreeAgreement(const FGraphBinding& Binding, TArray<FString>& OutIssues)
		{
			if (!Binding.Graph)
			{
				OutIssues.Add(TEXT("The behavior tree has no editor graph; mutations create one and mirror the compiled tree into it."));
				return;
			}
			TMap<const UBTNode*, UAIGraphNode*> GraphNodeByInstance;
			BuildGraphInstanceMap(Binding.Graph, GraphNodeByInstance);
			TSet<const UBTNode*> TreeInstances;
			TArray<UBTNode*> TreeNodes;
			CollectAllTreeNodes(Binding.Tree, TreeNodes);
			for (UBTNode* Node : TreeNodes)
			{
				TreeInstances.Add(Node);
			}
			for (const TPair<const UBTNode*, UAIGraphNode*>& Pair : GraphNodeByInstance)
			{
				if (!TreeInstances.Contains(Pair.Key))
				{
					OutIssues.Add(FString::Printf(TEXT("Graph node %s holds a node instance that is not part of the compiled tree."), *UEVGraph::NodeId(Pair.Value)));
				}
			}
			const bool bRootLinked = RootCompositeGraphNode(Binding.RootGraphNode) != nullptr;
			if (bRootLinked && !Binding.Tree->RootNode)
			{
				OutIssues.Add(TEXT("The graph root pin is linked but the tree has no root node."));
			}
			else if (!bRootLinked && Binding.Tree->RootNode)
			{
				OutIssues.Add(TEXT("The tree has a root node but the graph root pin is not linked."));
			}
		}

		void PopulateStructure(
			const FGraphBinding& Binding,
			FJsonObjectPtr Result,
			bool bIncludeGraphDetail,
			bool bNoteMissingGraph,
			const TArray<FString>& ExtraIssues = TArray<FString>())
		{
			TMap<const UBTNode*, UAIGraphNode*> GraphNodeByInstance;
			BuildGraphInstanceMap(Binding.Graph, GraphNodeByInstance);

			FWalkState State;
			if (Binding.Tree && Binding.Tree->RootNode)
			{
				WalkNode(Binding.Tree->RootNode, Binding.Tree->RootDecorators, -1, FString(), 0, GraphNodeByInstance, State);
			}

			TArray<TSharedPtr<FJsonValue>> Nodes;
			for (const FNodeEntry& Entry : State.Entries)
			{
				Nodes.Add(MakeShared<FJsonValueObject>(EntryToJson(Entry)));
			}
			Result->SetArrayField(TEXT("nodes"), Nodes);

			TArray<TSharedPtr<FJsonValue>> Decorators;
			TArray<TSharedPtr<FJsonValue>> Services;
			for (const FSubNodeEntry& Entry : State.SubNodes)
			{
				(Entry.Kind == TEXT("decorator") ? Decorators : Services).Add(MakeShared<FJsonValueObject>(SubNodeToJson(Entry)));
			}
			Result->SetArrayField(TEXT("decorators"), Decorators);
			Result->SetArrayField(TEXT("services"), Services);
			Result->SetNumberField(TEXT("execution_index_max"), State.MaxExecutionIndex);
			Result->SetNumberField(TEXT("tree_node_count"), State.Entries.Num());
			Result->SetNumberField(TEXT("max_depth"), State.MaxDepth);

			if (bIncludeGraphDetail)
			{
				FJsonObjectPtr GraphJson = UEVGraph::MakeObject();
				GraphJson->SetBoolField(TEXT("exists"), Binding.Graph != nullptr);
				if (Binding.Graph)
				{
					GraphJson->SetStringField(TEXT("graph_name"), Binding.Graph->GetName());
					GraphJson->SetStringField(TEXT("graph_class"), ClassPathOf(Binding.Graph));
					GraphJson->SetStringField(TEXT("root_node_id"), Binding.RootGraphNode ? UEVGraph::NodeId(Binding.RootGraphNode) : FString());
					GraphJson->SetBoolField(TEXT("root_linked"), RootCompositeGraphNode(Binding.RootGraphNode) != nullptr);
					TArray<UAIGraphNode*> All;
					CollectAllGraphNodes(Binding.Graph, All);
					GraphJson->SetNumberField(TEXT("node_count"), All.Num());
					UAIGraphNode* RootPinTarget = RootCompositeGraphNode(Binding.RootGraphNode);
					TArray<TSharedPtr<FJsonValue>> GraphNodeEntries;
					for (UAIGraphNode* GraphNode : All)
					{
						if (!GraphNode)
						{
							continue;
						}
						FJsonObjectPtr NodeJson = UEVGraph::MakeObject();
						NodeJson->SetStringField(TEXT("id"), UEVGraph::NodeId(GraphNode));
						NodeJson->SetStringField(TEXT("class_name"), GraphNode->GetClass()->GetName());
						UObject* Instance = GraphNode->NodeInstance;
						NodeJson->SetBoolField(TEXT("instance_null"), Instance == nullptr);
						NodeJson->SetStringField(TEXT("instance_class"), Instance ? ClassPathOf(Instance) : FString());
						NodeJson->SetStringField(TEXT("instance_name"), Instance ? Instance->GetName() : FString());
						NodeJson->SetStringField(TEXT("instance_outer"), Instance && Instance->GetOuter() ? ClassPathOf(Instance->GetOuter()) : FString());
						NodeJson->SetBoolField(TEXT("instance_in_tree"), Instance && GraphNodeByInstance.Contains(Cast<UBTNode>(Instance)));
						NodeJson->SetBoolField(TEXT("root_pin_target"), GraphNode == RootPinTarget);
						NodeJson->SetBoolField(TEXT("is_composite_instance"), Cast<UBTCompositeNode>(Instance) != nullptr);
						NodeJson->SetNumberField(TEXT("pin_count"), GraphNode->Pins.Num());
						int32 LinkedInputs = 0;
						for (const UEdGraphPin* Pin : GraphNode->Pins)
						{
							if (Pin && Pin->Direction == EGPD_Input)
							{
								LinkedInputs += Pin->LinkedTo.Num();
							}
						}
						NodeJson->SetNumberField(TEXT("linked_input_count"), LinkedInputs);
						GraphNodeEntries.Add(MakeShared<FJsonValueObject>(NodeJson));
					}
					GraphJson->SetArrayField(TEXT("graph_nodes"), GraphNodeEntries);
					const int32 ModCounter = ReadIntProperty(Binding.Graph, TEXT("ModCounter"));
					if (ModCounter >= 0)
					{
						GraphJson->SetNumberField(TEXT("mod_counter"), ModCounter);
					}
				}
				Result->SetObjectField(TEXT("graph"), GraphJson);
			}

			TArray<FString> Issues = ExtraIssues;
			if (bNoteMissingGraph && !Binding.Graph)
			{
				Issues.Add(TEXT("This behavior tree has no editor graph yet. Any bt_* mutation creates one and mirrors the compiled tree into it."));
			}
			TArray<FString> Agreement;
			VerifyGraphTreeAgreement(Binding, Agreement);
			for (const FString& Issue : Agreement)
			{
				Issues.AddUnique(Issue);
			}
			Result->SetArrayField(TEXT("issues"), MakeStringArray(Issues));

			TArray<FString> Warnings = State.Warnings;
			const TArray<TSharedPtr<FJsonValue>>* ExistingWarnings = nullptr;
			if (Result->TryGetArrayField(TEXT("warnings"), ExistingWarnings) && ExistingWarnings)
			{
				for (const TSharedPtr<FJsonValue>& Value : *ExistingWarnings)
				{
					FString Text;
					if (Value.IsValid() && Value->TryGetString(Text))
					{
						Warnings.AddUnique(Text);
					}
				}
			}
			Result->SetArrayField(TEXT("warnings"), MakeStringArray(Warnings));
		}

		void CollectIdsForInstances(const FGraphBinding& Binding, const TSet<const UBTNode*>& Wanted, TArray<FString>& OutIds)
		{
			TMap<const UBTNode*, UAIGraphNode*> GraphNodeByInstance;
			BuildGraphInstanceMap(Binding.Graph, GraphNodeByInstance);
			FWalkState State;
			if (Binding.Tree && Binding.Tree->RootNode)
			{
				WalkNode(Binding.Tree->RootNode, Binding.Tree->RootDecorators, -1, FString(), 0, GraphNodeByInstance, State);
			}
			for (const FNodeEntry& Entry : State.Entries)
			{
				if (Entry.Instance && Wanted.Contains(Entry.Instance))
				{
					OutIds.Add(Entry.Id);
				}
			}
			for (const FSubNodeEntry& Entry : State.SubNodes)
			{
				if (Entry.Instance && Wanted.Contains(Entry.Instance))
				{
					OutIds.Add(Entry.Id);
				}
			}
		}

		// ------------------------------------------------------------------
		// Node reference resolution
		// ------------------------------------------------------------------
		bool ResolveNodeRef(const FGraphBinding& Binding, const FString& RawId, FResolvedNode& Out, FString& OutError)
		{
			Out = FResolvedNode();
			const FString Id = RawId.TrimStartAndEnd();
			if (Id.IsEmpty())
			{
				OutError = TEXT("node_id is required.");
				return false;
			}

			FString BaseId;
			TCHAR Marker = TEXT('\0');
			int32 SubIndex = INDEX_NONE;
			if (SplitSubNodeId(Id, BaseId, Marker, SubIndex))
			{
				FResolvedNode Owner;
				if (!ResolveNodeRef(Binding, BaseId, Owner, OutError))
				{
					return false;
				}
				if (!Owner.GraphNode)
				{
					OutError = FString::Printf(TEXT("%s has no graph node, so it has no sub-nodes."), *BaseId);
					return false;
				}
				const TArray<UAIGraphNode*> Subs = (Marker == TEXT('d')) ? DecoratorSubNodes(Owner.GraphNode) : ServiceSubNodes(Owner.GraphNode);
				if (!Subs.IsValidIndex(SubIndex))
				{
					OutError = FString::Printf(TEXT("%s does not exist; %s has %d %s(s)."), *Id, *BaseId, Subs.Num(), Marker == TEXT('d') ? TEXT("decorator") : TEXT("service"));
					return false;
				}
				Out.Id = Id;
				Out.GraphNode = Subs[SubIndex];
				Out.Instance = Cast<UBTNode>(Subs[SubIndex]->NodeInstance);
				Out.Kind = (Marker == TEXT('d')) ? TEXT("decorator") : TEXT("service");
				Out.ExecutionIndex = Owner.ExecutionIndex;
				if (!Out.Instance)
				{
					OutError = FString::Printf(TEXT("%s has no node instance."), *Id);
					return false;
				}
				return true;
			}

			if (Id.Equals(TEXT("root"), ESearchCase::IgnoreCase) || Id.Equals(TEXT("root_node"), ESearchCase::IgnoreCase) || Id.Equals(TEXT("ei:root"), ESearchCase::IgnoreCase))
			{
				if (!Binding.RootGraphNode)
				{
					OutError = TEXT("The behavior tree graph has no root node.");
					return false;
				}
				Out.Id = TEXT("root");
				Out.Kind = TEXT("root");
				Out.GraphNode = Binding.RootGraphNode;
				return true;
			}

			TMap<const UBTNode*, UAIGraphNode*> GraphNodeByInstance;
			BuildGraphInstanceMap(Binding.Graph, GraphNodeByInstance);

			TArray<UAIGraphNode*> All;
			CollectAllGraphNodes(Binding.Graph, All);
			for (UAIGraphNode* GraphNode : All)
			{
				const FString GuidHyphenated = GraphNode->NodeGuid.ToString(EGuidFormats::DigitsWithHyphens);
				const FString GuidDigits = GraphNode->NodeGuid.ToString(EGuidFormats::Digits);
				if (Id.Equals(GuidHyphenated, ESearchCase::IgnoreCase)
					|| Id.Equals(GuidDigits, ESearchCase::IgnoreCase)
					|| Id.Equals(GraphNode->GetName(), ESearchCase::IgnoreCase))
				{
					Out.Id = UEVGraph::NodeId(GraphNode);
					Out.GraphNode = GraphNode;
					Out.Instance = Cast<UBTNode>(GraphNode->NodeInstance);
					if (!Out.Instance && !IsRootGraphNode(GraphNode))
					{
						OutError = FString::Printf(TEXT("Graph node %s has no node instance."), *Out.Id);
						return false;
					}
					Out.Kind = !Out.Instance ? TEXT("root") : (Cast<UBTCompositeNode>(Out.Instance) ? TEXT("composite") : TEXT("task"));
					Out.ExecutionIndex = Out.Instance ? static_cast<int32>(Out.Instance->GetExecutionIndex()) : INDEX_NONE;
					return true;
				}
			}

			TArray<UBTNode*> TreeNodes;
			CollectAllTreeNodes(Binding.Tree, TreeNodes);
			if (Id.StartsWith(TEXT("ei:"), ESearchCase::IgnoreCase) && Id.RightChop(3).IsNumeric())
			{
				const int32 Wanted = FCString::Atoi(*Id.RightChop(3));
				for (UBTNode* Node : TreeNodes)
				{
					if (static_cast<int32>(Node->GetExecutionIndex()) == Wanted)
					{
						Out.Id = NodeIdOfExecutionIndex(Wanted);
						Out.Instance = Node;
						Out.ExecutionIndex = Wanted;
						Out.Kind = Cast<UBTCompositeNode>(Node) ? TEXT("composite") : TEXT("task");
						Out.GraphNode = GraphNodeByInstance.FindRef(Node);
						if (!Out.GraphNode)
						{
							OutError = FString::Printf(TEXT("%s is in the compiled tree but has no graph node; run bt_repair_graph and retry."), *Id);
							return false;
						}
						return true;
					}
				}
			}

			for (UBTNode* Node : TreeNodes)
			{
				if (Id.Equals(Node->GetName(), ESearchCase::IgnoreCase))
				{
					Out.Id = NodeIdOfExecutionIndex(static_cast<int32>(Node->GetExecutionIndex()));
					Out.Instance = Node;
					Out.ExecutionIndex = static_cast<int32>(Node->GetExecutionIndex());
					Out.Kind = Cast<UBTCompositeNode>(Node) ? TEXT("composite") : TEXT("task");
					Out.GraphNode = GraphNodeByInstance.FindRef(Node);
					if (!Out.GraphNode)
					{
						OutError = FString::Printf(TEXT("%s is in the compiled tree but has no graph node; run bt_repair_graph and retry."), *Id);
						return false;
					}
					return true;
				}
			}

			OutError = FString::Printf(TEXT("Could not resolve node_id '%s'. Use ids from bt_inspect: ei:<n> for tree nodes, ei:<n>/d<k> for decorators, ei:<n>/s<k> for services, or root for the graph root."), *Id);
			return false;
		}

		// ------------------------------------------------------------------
		// Property helpers
		// ------------------------------------------------------------------
		bool SetObjectPropertyByName(UObject* Owner, const FName PropertyName, UObject* Value)
		{
			if (!Owner)
			{
				return false;
			}
			FObjectPropertyBase* Property = FindFProperty<FObjectPropertyBase>(Owner->GetClass(), PropertyName);
			if (!Property)
			{
				return false;
			}
			Owner->Modify();
			Property->SetObjectPropertyValue_InContainer(Owner, Value);
			return true;
		}

		FProperty* FindPropertyLoose(UStruct* Struct, const FString& Name)
		{
			if (!Struct || Name.IsEmpty())
			{
				return nullptr;
			}
			if (FProperty* Exact = Struct->FindPropertyByName(FName(*Name)))
			{
				return Exact;
			}
			FString Normalized = Name;
			Normalized.ReplaceInline(TEXT("_"), TEXT(""));
			for (TFieldIterator<FProperty> It(Struct); It; ++It)
			{
				FString Candidate = It->GetName();
				Candidate.ReplaceInline(TEXT("_"), TEXT(""));
				if (Candidate.Equals(Normalized, ESearchCase::IgnoreCase))
				{
					return *It;
				}
			}
			return nullptr;
		}

		bool PropertyIsEditConst(UObject* Object, const FString& PropertyPath)
		{
			if (!Object)
			{
				return false;
			}
			FString Head = PropertyPath;
			int32 DotIndex = INDEX_NONE;
			if (PropertyPath.FindChar(TEXT('.'), DotIndex))
			{
				Head = PropertyPath.Left(DotIndex);
			}
			FProperty* Property = FindPropertyLoose(Object->GetClass(), Head);
			return Property && Property->HasAnyPropertyFlags(CPF_EditConst);
		}

		bool ReadPropertySummary(UObject* Object, const FString& PropertyPath, FString& OutText)
		{
			if (!Object)
			{
				return false;
			}
			FString Head = PropertyPath;
			int32 DotIndex = INDEX_NONE;
			if (PropertyPath.FindChar(TEXT('.'), DotIndex))
			{
				Head = PropertyPath.Left(DotIndex);
			}
			FProperty* Property = FindPropertyLoose(Object->GetClass(), Head);
			if (!Property)
			{
				return false;
			}
			if (FBoolProperty* BoolProperty = CastField<FBoolProperty>(Property))
			{
				OutText = BoolProperty->GetPropertyValue_InContainer(Object) ? TEXT("true") : TEXT("false");
				return true;
			}
			if (FStrProperty* StrProperty = CastField<FStrProperty>(Property))
			{
				OutText = StrProperty->GetPropertyValue_InContainer(Object);
				return true;
			}
			if (FNameProperty* NameProperty = CastField<FNameProperty>(Property))
			{
				OutText = NameProperty->GetPropertyValue_InContainer(Object).ToString();
				return true;
			}
			if (FEnumProperty* EnumProperty = CastField<FEnumProperty>(Property))
			{
				FNumericProperty* Underlying = EnumProperty->GetUnderlyingProperty();
				const int64 Raw = Underlying ? Underlying->GetSignedIntPropertyValue(EnumProperty->ContainerPtrToValuePtr<void>(Object)) : 0;
				OutText = EnumProperty->GetEnum() ? EnumProperty->GetEnum()->GetNameStringByValue(Raw) : FString::Printf(TEXT("%lld"), static_cast<long long>(Raw));
				return true;
			}
			if (FByteProperty* ByteProperty = CastField<FByteProperty>(Property))
			{
				const int64 Raw = ByteProperty->GetPropertyValue_InContainer(Object);
				OutText = ByteProperty->Enum ? ByteProperty->Enum->GetNameStringByValue(Raw) : FString::Printf(TEXT("%lld"), static_cast<long long>(Raw));
				return true;
			}
			if (FNumericProperty* NumericProperty = CastField<FNumericProperty>(Property))
			{
				if (NumericProperty->IsFloatingPoint())
				{
					OutText = FString::SanitizeFloat(NumericProperty->GetFloatingPointPropertyValue(NumericProperty->ContainerPtrToValuePtr<void>(Object)));
				}
				else
				{
					OutText = FString::Printf(TEXT("%lld"), static_cast<long long>(NumericProperty->GetSignedIntPropertyValue(NumericProperty->ContainerPtrToValuePtr<void>(Object))));
				}
				return true;
			}
			if (FObjectPropertyBase* ObjectProperty = CastField<FObjectPropertyBase>(Property))
			{
				UObject* Value = ObjectProperty->GetObjectPropertyValue_InContainer(Object);
				OutText = Value ? Value->GetPathName() : FString(TEXT("None"));
				return true;
			}
			return false;
		}

		bool ApplyProperties(UObject* Object, const FJsonObject& Properties, TArray<FString>& OutErrors)
		{
			bool bOkay = true;
			for (const TPair<FString, TSharedPtr<FJsonValue>>& Pair : Properties.Values)
			{
				if (!Pair.Value.IsValid())
				{
					continue;
				}
				if (PropertyIsEditConst(Object, Pair.Key))
				{
					bOkay = false;
					OutErrors.Add(FString::Printf(TEXT("%s is read-only on %s."), *Pair.Key, *ClassNameOf(Object)));
					continue;
				}
				FString Error;
				if (!UEVGraph::SetObjectPropertyPath(Object, Pair.Key, Pair.Value, Error))
				{
					bOkay = false;
					OutErrors.Add(FString::Printf(TEXT("%s: %s"), *Pair.Key, *Error));
				}
			}
			return bOkay;
		}

		UClass* CompositeGraphNodeClass(UClass* InstanceClass)
		{
			if (InstanceClass && InstanceClass->IsChildOf(UBTComposite_SimpleParallel::StaticClass()))
			{
				return LoadClassPath(SimpleParallelGraphNodeClassPath);
			}
			return LoadClassPath(CompositeGraphNodeClassPath);
		}

		FJsonObjectPtr FinishMutation(FGraphBinding& Binding, const FJsonObject& Args, FJsonObjectPtr Result, const TArray<FString>& ExtraIssues = TArray<FString>())
		{
			if (Binding.Graph)
			{
				// UBehaviorTreeGraph::CreateBTFromGraph dereferences the linked root node's instance
				// without a null check (BehaviorTreeGraph.cpp:922 -> CreateChildren:514), so an
				// inconsistent root link turns any mutation into an editor crash. Refuse instead.
				if (UAIGraphNode* RootTarget = RootCompositeGraphNode(Binding.RootGraphNode))
				{
					if (!Cast<UBTCompositeNode>(RootTarget->NodeInstance))
					{
						FJsonObjectPtr Failure = MakeFailure(FString::Printf(
							TEXT("The graph root pin is linked to %s, which has no usable composite instance; recompiling the graph would crash the editor. Run bt_repair_graph to rebuild the root node."),
							*UEVGraph::NodeId(RootTarget)));
						Failure->SetBoolField(TEXT("graph_root_invalid"), true);
						return Failure;
					}
				}
				Binding.Graph->UpdateAsset();
			}
			LayoutGraph(Binding);
			PopulateStructure(Binding, Result, true, false, ExtraIssues);
			Result->SetBoolField(TEXT("graph_synced"), Binding.Graph != nullptr);
			return UEVGraph::FinalizeAssetEdit(Binding.Tree, Args, Result);
		}

		FJsonObjectPtr FinishReadOnly(FGraphBinding& Binding, FJsonObjectPtr Result, bool bIncludeGraphDetail)
		{
			LayoutGraph(Binding);
			PopulateStructure(Binding, Result, bIncludeGraphDetail, true);
			return Result;
		}

		// ------------------------------------------------------------------
		// Argument helpers
		// ------------------------------------------------------------------
		FString TreeIdentifier(const FJsonObject& Args)
		{
			FString Identifier = UEVGraph::GetString(Args, TEXT("behavior_tree_path"));
			if (Identifier.IsEmpty())
			{
				Identifier = UEVGraph::GetString(Args, TEXT("behavior_tree"));
			}
			if (Identifier.IsEmpty())
			{
				Identifier = UEVGraph::GetString(Args, TEXT("asset_path"));
			}
			if (Identifier.IsEmpty())
			{
				Identifier = UEVGraph::GetString(Args, TEXT("path"));
			}
			if (Identifier.IsEmpty())
			{
				Identifier = UEVGraph::GetString(Args, TEXT("name"));
			}
			return Identifier.TrimStartAndEnd();
		}

		UBehaviorTree* LoadBehaviorTree(const FJsonObject& Args, FString& OutError)
		{
			const FString Identifier = TreeIdentifier(Args);
			if (Identifier.IsEmpty())
			{
				OutError = TEXT("behavior_tree_path is required.");
				return nullptr;
			}
			UObject* Asset = UEVGraph::LoadAsset(Identifier, UBehaviorTree::StaticClass(), OutError);
			if (!Asset)
			{
				if (OutError.IsEmpty())
				{
					OutError = FString::Printf(TEXT("Could not load behavior tree: %s"), *Identifier);
				}
				return nullptr;
			}
			return Cast<UBehaviorTree>(Asset);
		}

		FString ValueToText(const TSharedPtr<FJsonValue>& Value)
		{
			if (!Value.IsValid())
			{
				return FString();
			}
			switch (Value->Type)
			{
			case EJson::String:
				return Value->AsString();
			case EJson::Boolean:
				return Value->AsBool() ? TEXT("true") : TEXT("false");
			case EJson::Number:
			{
				const double Number = Value->AsNumber();
				const double Rounded = FMath::RoundToDouble(Number);
				if (FMath::IsNearlyEqual(Number, Rounded))
				{
					return FString::Printf(TEXT("%lld"), static_cast<long long>(Rounded));
				}
				return FString::SanitizeFloat(Number);
			}
			case EJson::Null:
				return TEXT("None");
			default:
				return FString(TEXT("<structured value>"));
			}
		}

		FString FindEntryIdByGraphNode(const FJsonObjectPtr& Result, const TCHAR* FieldName, const FString& GraphNodeId)
		{
			const TArray<TSharedPtr<FJsonValue>>* Array = nullptr;
			if (!GraphNodeId.IsEmpty() && Result->TryGetArrayField(FieldName, Array) && Array)
			{
				for (const TSharedPtr<FJsonValue>& Value : *Array)
				{
					const TSharedPtr<FJsonObject>* Object = nullptr;
					if (!Value.IsValid() || !Value->TryGetObject(Object) || !Object || !Object->IsValid())
					{
						continue;
					}
					FString Candidate;
					if ((*Object)->TryGetStringField(TEXT("graph_node_id"), Candidate) && Candidate.Equals(GraphNodeId, ESearchCase::IgnoreCase))
					{
						FString Id;
						(*Object)->TryGetStringField(TEXT("id"), Id);
						return Id;
					}
				}
			}
			return FString();
		}

		// ------------------------------------------------------------------
		// bt_inspect
		// ------------------------------------------------------------------
		FJsonObjectPtr OpInspect(const FJsonObject& Args)
		{
			FString Error;
			UBehaviorTree* Tree = LoadBehaviorTree(Args, Error);
			if (!Tree)
			{
				return MakeFailure(Error);
			}

			FGraphBinding Binding;
			Binding.Tree = Tree;
			Binding.Graph = Cast<UAIGraph>(Tree->BTGraph);
			Binding.RootGraphNode = FindRootGraphNode(Binding.Graph);

			// Reuse the 1.6 inspector so bt_inspect is a strict superset of inspect_behavior_tree.
			FJsonObjectPtr Result;
			{
				const FString Described = UUEVGraphAI::DescribeBehaviorTree(Tree->GetPathName());
				TSharedPtr<FJsonObject> Parsed;
				const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Described);
				if (FJsonSerializer::Deserialize(Reader, Parsed) && Parsed.IsValid())
				{
					Result = Parsed;
				}
			}
			if (!Result.IsValid())
			{
				Result = UEVGraph::MakeSuccess();
			}
			Result->SetStringField(TEXT("behavior_tree_path"), Tree->GetPathName());
			Result->SetBoolField(TEXT("graph_exists"), Tree->BTGraph != nullptr);
			return FinishReadOnly(Binding, Result, UEVGraph::GetBool(Args, TEXT("include_graph"), true));
		}

		// ------------------------------------------------------------------
		// bt_create
		// ------------------------------------------------------------------
		FJsonObjectPtr OpCreate(const FJsonObject& Args)
		{
			if (FJsonObjectPtr Guard = PieGuard(TEXT("create a behavior tree")))
			{
				return Guard;
			}

			FString Requested = UEVGraph::GetString(Args, TEXT("name"));
			if (Requested.IsEmpty())
			{
				Requested = UEVGraph::GetString(Args, TEXT("asset_name"));
			}
			Requested = Requested.TrimStartAndEnd();
			if (Requested.IsEmpty())
			{
				return MakeFailure(TEXT("name or asset_name is required, for example name=\"BT_Guard\" path=\"/Game/AI\"."));
			}

			FString PackagePath = UEVGraph::GetString(Args, TEXT("path"), TEXT("/Game/AI")).TrimStartAndEnd();
			FString AssetName = Requested;
			int32 SlashIndex = INDEX_NONE;
			if (Requested.FindLastChar(TEXT('/'), SlashIndex))
			{
				PackagePath = Requested.Left(SlashIndex);
				AssetName = Requested.RightChop(SlashIndex + 1);
			}
			if (PackagePath.IsEmpty())
			{
				PackagePath = TEXT("/Game/AI");
			}
			while (PackagePath.EndsWith(TEXT("/")))
			{
				PackagePath = PackagePath.LeftChop(1);
			}
			if (!PackagePath.StartsWith(TEXT("/Game/"), ESearchCase::IgnoreCase))
			{
				return MakeFailure(FString::Printf(TEXT("Behavior tree assets must live under /Game/ (got %s)."), *PackagePath));
			}
			if (AssetName.IsEmpty())
			{
				return MakeFailure(TEXT("The behavior tree asset name is empty."));
			}

			const FString PackageName = FString::Printf(TEXT("%s/%s"), *PackagePath, *AssetName);
			// Existence is decided by the asset registry and the disk, not by a global
			// FindObject: a transient in-memory object that happens to carry the package
			// path made every retry look like a duplicate (#bt-create-ghost).
			const FAssetData ExistingAsset = FAssetRegistryModule::GetRegistry().GetAssetByObjectPath(
				FName(*(PackageName + TEXT(".") + AssetName)));
			UPackage* ExistingPackage = FindPackage(nullptr, *PackageName);
			const bool bExistsInMemory = ExistingPackage != nullptr && FindObject<UObject>(ExistingPackage, *AssetName) != nullptr;
			if (ExistingAsset.IsValid() || bExistsInMemory || FPackageName::DoesPackageExist(PackageName))
			{
				return MakeFailure(FString::Printf(TEXT("Asset %s already exists. Inspect it with bt_inspect instead."), *PackageName));
			}

			FScopedEditorTransaction Transaction(FString::Printf(TEXT("UEV create behavior tree: %s"), *AssetName));
			UPackage* Package = CreatePackage(*PackageName);
			if (!Package)
			{
				return MakeFailure(FString::Printf(TEXT("Could not create package %s."), *PackageName));
			}
			UBehaviorTree* Tree = NewObject<UBehaviorTree>(Package, FName(*AssetName), RF_Public | RF_Standalone | RF_Transactional);
			if (!Tree)
			{
				return MakeFailure(FString::Printf(TEXT("Could not create behavior tree %s."), *PackageName));
			}
			FAssetRegistryModule::AssetCreated(Tree);
			Package->MarkPackageDirty();

			TArray<FString> Issues;
			const FString BlackboardRef = UEVGraph::GetString(Args, TEXT("blackboard_path"));
			if (!BlackboardRef.IsEmpty())
			{
				FString BlackboardError;
				if (UObject* BlackboardAsset = UEVGraph::LoadAsset(BlackboardRef, UBlackboardData::StaticClass(), BlackboardError))
				{
					Tree->BlackboardAsset = Cast<UBlackboardData>(BlackboardAsset);
				}
				else
				{
					Issues.Add(BlackboardError);
				}
			}

			FJsonObjectPtr Result = UEVGraph::MakeSuccess();
			Result->SetBoolField(TEXT("created"), true);
			Result->SetStringField(TEXT("behavior_tree_path"), Tree->GetPathName());
			Result->SetStringField(TEXT("root_id"), FString());
			Result->SetBoolField(TEXT("graph_created"), false);
			Result->SetStringField(TEXT("blackboard_path"), Tree->BlackboardAsset ? Tree->BlackboardAsset->GetPathName() : FString());

			FGraphBinding Binding;
			Binding.Tree = Tree;
			Binding.Graph = nullptr;
			Binding.RootGraphNode = nullptr;

			const FString RootClass = UEVGraph::GetString(Args, TEXT("root_class"));
			if (!RootClass.IsEmpty())
			{
				FString Error;
				UClass* InstanceClass = UEVGraph::ResolveClass(RootClass, UBTCompositeNode::StaticClass(), Error);
				if (!InstanceClass)
				{
					return MakeFailure(Error);
				}
				if (InstanceClass->HasAnyClassFlags(CLASS_Abstract))
				{
					return MakeFailure(FString::Printf(TEXT("Class %s is abstract and cannot be the root node."), *InstanceClass->GetName()));
				}
				if (!BindGraph(Tree, Binding, Error))
				{
					return MakeFailure(Error);
				}
				Tree->Modify();
				Binding.Graph->Modify();
				UAIGraphNode* RootComposite = nullptr;
				{
					FScopedGraphLock Lock(Binding.Graph);
					RootComposite = SpawnGraphNode(Binding, InstanceClass, CompositeGraphNodeClass(InstanceClass), Error);
					if (!RootComposite)
					{
						return MakeFailure(Error);
					}
					if (!LinkChild(Binding, Binding.RootGraphNode, RootComposite, Error))
					{
						DestroyGraphNodeRecursive(Binding, RootComposite);
						return MakeFailure(Error);
					}
				}
			}

			FJsonObjectPtr Done = FinishMutation(Binding, Args, Result, Issues);
			Done->SetBoolField(TEXT("graph_created"), Binding.Graph != nullptr);
			if (UAIGraphNode* RootNode = RootCompositeGraphNode(Binding.RootGraphNode))
			{
				if (UBTNode* Instance = Cast<UBTNode>(RootNode->NodeInstance))
				{
					Done->SetStringField(TEXT("root_id"), NodeIdOfExecutionIndex(static_cast<int32>(Instance->GetExecutionIndex())));
				}
			}
			return Done;
		}

		// ------------------------------------------------------------------
		// bt_add_node
		// ------------------------------------------------------------------
		FJsonObjectPtr OpAddNode(const FJsonObject& Args)
		{
			if (FJsonObjectPtr Guard = PieGuard(TEXT("add a behavior tree node")))
			{
				return Guard;
			}
			FString Error;
			UBehaviorTree* Tree = LoadBehaviorTree(Args, Error);
			if (!Tree)
			{
				return MakeFailure(Error);
			}

			const FString RequestedClass = UEVGraph::GetString(Args, TEXT("node_class"));
			if (RequestedClass.IsEmpty())
			{
				return MakeFailure(TEXT("node_class is required, for example /Script/AIModule.BTTask_Wait or /Script/AIModule.BTComposite_Sequence."));
			}
			UClass* InstanceClass = UEVGraph::ResolveClass(RequestedClass, UBTNode::StaticClass(), Error);
			if (!InstanceClass)
			{
				return MakeFailure(Error);
			}
			if (InstanceClass->HasAnyClassFlags(CLASS_Abstract))
			{
				return MakeFailure(FString::Printf(TEXT("Class %s is abstract and cannot be added."), *InstanceClass->GetName()));
			}
			const bool bComposite = InstanceClass->IsChildOf(UBTCompositeNode::StaticClass());
			const bool bTask = InstanceClass->IsChildOf(UBTTaskNode::StaticClass());

			FString Kind = UEVGraph::GetString(Args, TEXT("kind"), bComposite ? TEXT("composite") : TEXT("task")).ToLower();
			if (Kind.IsEmpty() || Kind == TEXT("auto"))
			{
				Kind = bComposite ? TEXT("composite") : TEXT("task");
			}
			if (Kind == TEXT("composite") && !bComposite)
			{
				return MakeFailure(FString::Printf(TEXT("Class %s is not a composite node; use kind=task."), *InstanceClass->GetName()));
			}
			if (Kind == TEXT("task") && !bTask)
			{
				return MakeFailure(FString::Printf(TEXT("Class %s is not a task node; use kind=composite."), *InstanceClass->GetName()));
			}
			if (Kind != TEXT("composite") && Kind != TEXT("task"))
			{
				return MakeFailure(TEXT("kind must be composite or task."));
			}
			UClass* GraphNodeClass = bComposite ? CompositeGraphNodeClass(InstanceClass) : LoadClassPath(TaskGraphNodeClassPath);

			FScopedEditorTransaction Transaction(FString::Printf(TEXT("UEV add behavior tree node: %s"), *InstanceClass->GetName()));
			FGraphBinding Binding;
			if (!BindGraph(Tree, Binding, Error))
			{
				return MakeFailure(Error);
			}

			const FString ParentRef = UEVGraph::GetString(Args, TEXT("parent_id")).TrimStartAndEnd();
			UAIGraphNode* ParentGraphNode = Binding.RootGraphNode;
			FString ParentId = TEXT("root");
			bool bRootSlot = ParentRef.IsEmpty() || ParentRef.Equals(TEXT("root"), ESearchCase::IgnoreCase);
			if (!bRootSlot)
			{
				FResolvedNode Resolved;
				if (!ResolveNodeRef(Binding, ParentRef, Resolved, Error))
				{
					return MakeFailure(Error);
				}
				if (!Cast<UBTCompositeNode>(Resolved.Instance))
				{
					return MakeFailure(FString::Printf(TEXT("%s is a %s node; only composites can take children."), *Resolved.Id, *Resolved.Kind));
				}
				ParentGraphNode = Resolved.GraphNode;
				ParentId = Resolved.Id;
			}
			else
			{
				if (Tree->RootNode)
				{
					return MakeFailure(FString::Printf(TEXT("This behavior tree already has a root node (%s). Pass parent_id to add a child."), *NodeIdOfExecutionIndex(0)));
				}
				// The root slot of a behavior tree can only hold a composite: the engine compiles the
				// root node with Cast<UBTCompositeNode>() and then dereferences it without a check.
				if (!bComposite)
				{
					return MakeFailure(FString::Printf(TEXT("Class %s cannot be the root of a behavior tree; the root must be a composite such as /Script/AIModule.BTComposite_Selector."), *InstanceClass->GetName()));
				}
			}
			if (!ParentGraphNode)
			{
				return MakeFailure(TEXT("The behavior tree graph has no root node to attach to."));
			}

			Tree->Modify();
			Binding.Graph->Modify();

			UAIGraphNode* AddedNode = nullptr;
			{
				FScopedGraphLock Lock(Binding.Graph);
				AddedNode = SpawnGraphNode(Binding, InstanceClass, GraphNodeClass, Error);
				if (!AddedNode)
				{
					return MakeFailure(Error);
				}
				if (!LinkChild(Binding, ParentGraphNode, AddedNode, Error))
				{
					DestroyGraphNodeRecursive(Binding, AddedNode);
					return MakeFailure(Error);
				}
				// Appending is the default: a builder that omits index expects children in the
				// order it added them, and a fresh graph node starts at NodePosX 0, which used
				// to tie with the first sibling and sort ahead of it (#bt-add-order).
				const double RequestedIndex = UEVGraph::GetNumber(Args, TEXT("index"), -1.0);
				const int32 DesiredIndex = RequestedIndex >= 0.0
					? FMath::RoundToInt(RequestedIndex)
					: TNumericLimits<int32>::Max();
				if (!OrderChildAt(ParentGraphNode, AddedNode, DesiredIndex, Error))
				{
					return MakeFailure(Error);
				}
			}

			const FString GraphNodeId = UEVGraph::NodeId(AddedNode);
			FJsonObjectPtr Result = UEVGraph::MakeSuccess();
			Result->SetStringField(TEXT("parent_id"), ParentId);
			Result->SetStringField(TEXT("node_class"), ClassPathOf(AddedNode->NodeInstance));
			Result->SetStringField(TEXT("node_class_name"), ClassNameOf(AddedNode->NodeInstance));
			Result->SetStringField(TEXT("graph_node_id"), GraphNodeId);
			Result->SetStringField(TEXT("kind"), Kind);
			Result->SetBoolField(TEXT("created"), true);

			FJsonObjectPtr Done = FinishMutation(Binding, Args, Result);
			Done->SetStringField(TEXT("node_id"), FindEntryIdByGraphNode(Done, TEXT("nodes"), GraphNodeId));
			UBTNode* Instance = Cast<UBTNode>(AddedNode->NodeInstance);
			Done->SetNumberField(TEXT("execution_index"), Instance ? static_cast<int32>(Instance->GetExecutionIndex()) : INDEX_NONE);
			if (UBTCompositeNode* Composite = Cast<UBTCompositeNode>(Instance))
			{
				Done->SetNumberField(TEXT("children_count"), Composite->Children.Num());
			}
			else
			{
				Done->SetNumberField(TEXT("children_count"), 0);
			}
			return Done;
		}

		// ------------------------------------------------------------------
		// bt_remove_node
		// ------------------------------------------------------------------
		FJsonObjectPtr OpRemoveNode(const FJsonObject& Args)
		{
			if (FJsonObjectPtr Guard = PieGuard(TEXT("remove a behavior tree node")))
			{
				return Guard;
			}
			FString Error;
			UBehaviorTree* Tree = LoadBehaviorTree(Args, Error);
			if (!Tree)
			{
				return MakeFailure(Error);
			}
			FGraphBinding Binding;
			if (!BindGraph(Tree, Binding, Error))
			{
				return MakeFailure(Error);
			}
			FResolvedNode Resolved;
			if (!ResolveNodeRef(Binding, UEVGraph::GetString(Args, TEXT("node_id")), Resolved, Error))
			{
				return MakeFailure(Error);
			}
			if (Resolved.Kind == TEXT("root"))
			{
				return MakeFailure(TEXT("The graph root cannot be removed. Remove the root composite (" + NodeIdOfExecutionIndex(0) + TEXT(") to leave the tree without a root.")));
			}
			if (Resolved.Kind == TEXT("decorator") || Resolved.Kind == TEXT("service"))
			{
				return MakeFailure(FString::Printf(TEXT("%s is a %s; use bt_remove_%s instead."), *Resolved.Id, *Resolved.Kind, Resolved.Kind == TEXT("decorator") ? TEXT("decorator") : TEXT("service")));
			}

			TSet<const UBTNode*> Subtree;
			{
				TArray<UBTNode*> Collected;
				TSet<const UBTNode*> Seen;
				CollectTreeNodes(Resolved.Instance, Collected, Seen);
				for (UBTNode* Node : Collected)
				{
					Subtree.Add(Node);
				}
			}
			TArray<FString> RemovedIds;
			CollectIdsForInstances(Binding, Subtree, RemovedIds);

			UAIGraphNode* ParentGraphNode = FindParentGraphNode(Binding.Graph, Resolved.GraphNode);
			Tree->Modify();
			Binding.Graph->Modify();
			{
				FScopedGraphLock Lock(Binding.Graph);
				if (UEdGraphPin* InputPin = DirectionalPin(Resolved.GraphNode, EGPD_Input, 0))
				{
					InputPin->BreakAllPinLinks();
				}
				DestroyGraphNodeRecursive(Binding, Resolved.GraphNode);
			}

			FJsonObjectPtr Result = UEVGraph::MakeSuccess();
			Result->SetArrayField(TEXT("removed_ids"), MakeStringArray(RemovedIds));
			Result->SetNumberField(TEXT("removed_count"), RemovedIds.Num());
			Result->SetStringField(TEXT("parent_id"), ParentGraphNode ? UEVGraph::NodeId(ParentGraphNode) : FString());
			TArray<FString> Issues;
			if (!Tree->RootNode)
			{
				Issues.Add(TEXT("The behavior tree no longer has a root node; add a composite with bt_add_node to make it runnable."));
			}
			return FinishMutation(Binding, Args, Result, Issues);
		}

		// ------------------------------------------------------------------
		// bt_move_node
		// ------------------------------------------------------------------
		FJsonObjectPtr OpMoveNode(const FJsonObject& Args)
		{
			if (FJsonObjectPtr Guard = PieGuard(TEXT("move a behavior tree node")))
			{
				return Guard;
			}
			FString Error;
			UBehaviorTree* Tree = LoadBehaviorTree(Args, Error);
			if (!Tree)
			{
				return MakeFailure(Error);
			}
			FGraphBinding Binding;
			if (!BindGraph(Tree, Binding, Error))
			{
				return MakeFailure(Error);
			}
			FResolvedNode Moved;
			if (!ResolveNodeRef(Binding, UEVGraph::GetString(Args, TEXT("node_id")), Moved, Error))
			{
				return MakeFailure(Error);
			}
			if (Moved.Kind == TEXT("root") || Moved.Kind == TEXT("decorator") || Moved.Kind == TEXT("service"))
			{
				return MakeFailure(FString::Printf(TEXT("%s cannot be moved; bt_move_node only reparents composites and tasks."), *Moved.Id));
			}
			const FString NewParentRef = UEVGraph::GetString(Args, TEXT("new_parent_id")).TrimStartAndEnd();
			if (NewParentRef.IsEmpty())
			{
				return MakeFailure(TEXT("new_parent_id is required."));
			}
			UAIGraphNode* NewParentGraphNode = nullptr;
			FString NewParentId;
			if (NewParentRef.Equals(TEXT("root"), ESearchCase::IgnoreCase))
			{
				NewParentGraphNode = Binding.RootGraphNode;
				NewParentId = TEXT("root");
			}
			else
			{
				FResolvedNode NewParent;
				if (!ResolveNodeRef(Binding, NewParentRef, NewParent, Error))
				{
					return MakeFailure(Error);
				}
				if (!Cast<UBTCompositeNode>(NewParent.Instance))
				{
					return MakeFailure(FString::Printf(TEXT("%s is a %s node; only composites can take children."), *NewParent.Id, *NewParent.Kind));
				}
				NewParentGraphNode = NewParent.GraphNode;
				NewParentId = NewParent.Id;
			}

			FScopedEditorTransaction Transaction(TEXT("UEV move behavior tree node"));
			Tree->Modify();
			Binding.Graph->Modify();
			TArray<FString> Issues;
			{
				FScopedGraphLock Lock(Binding.Graph);
				if (UEdGraphPin* InputPin = DirectionalPin(Moved.GraphNode, EGPD_Input, 0))
				{
					InputPin->BreakAllPinLinks();
				}
				else
				{
					return MakeFailure(FString::Printf(TEXT("%s has no input pin, so it cannot be reparented."), *Moved.Id));
				}
				if (!LinkChild(Binding, NewParentGraphNode, Moved.GraphNode, Error))
				{
					return MakeFailure(Error);
				}
				// Same append-by-default rule as bt_add_node: omitting the index moves the node
				// to the end of the new parent instead of leaving NodePosX ties behind.
				const double RequestedIndex = UEVGraph::GetNumber(Args, TEXT("new_index"), UEVGraph::GetNumber(Args, TEXT("index"), -1.0));
				const int32 DesiredIndex = RequestedIndex >= 0.0
					? FMath::RoundToInt(RequestedIndex)
					: TNumericLimits<int32>::Max();
				if (!OrderChildAt(NewParentGraphNode, Moved.GraphNode, DesiredIndex, Error))
				{
					return MakeFailure(Error);
				}
			}

			FJsonObjectPtr Result = UEVGraph::MakeSuccess();
			Result->SetStringField(TEXT("node_id"), Moved.Id);
			Result->SetStringField(TEXT("parent_id"), NewParentId);
			Result->SetBoolField(TEXT("moved"), true);
			if (!Tree->RootNode)
			{
				Issues.Add(TEXT("The behavior tree no longer has a root node; add a composite with bt_add_node to make it runnable."));
			}
			return FinishMutation(Binding, Args, Result, Issues);
		}

		// ------------------------------------------------------------------
		// bt_set_node_property
		// ------------------------------------------------------------------
		FJsonObjectPtr OpSetNodeProperty(const FJsonObject& Args)
		{
			if (FJsonObjectPtr Guard = PieGuard(TEXT("set a behavior tree node property")))
			{
				return Guard;
			}
			FString Error;
			UBehaviorTree* Tree = LoadBehaviorTree(Args, Error);
			if (!Tree)
			{
				return MakeFailure(Error);
			}
			FGraphBinding Binding;
			if (!BindGraph(Tree, Binding, Error))
			{
				return MakeFailure(Error);
			}
			FResolvedNode Resolved;
			if (!ResolveNodeRef(Binding, UEVGraph::GetString(Args, TEXT("node_id")), Resolved, Error))
			{
				return MakeFailure(Error);
			}
			if (!Resolved.Instance)
			{
				return MakeFailure(FString::Printf(TEXT("%s has no runtime node instance to configure."), *Resolved.Id));
			}
			const FString Property = UEVGraph::GetString(Args, TEXT("property"));
			if (Property.IsEmpty())
			{
				return MakeFailure(TEXT("property is required."));
			}
			const TSharedPtr<FJsonValue> Value = Args.TryGetField(TEXT("value"));
			if (!Value.IsValid())
			{
				return MakeFailure(TEXT("value is required; it may be a string, number, boolean, object path, or object."));
			}
			if (PropertyIsEditConst(Resolved.Instance, Property))
			{
				return MakeFailure(FString::Printf(TEXT("%s is marked EditConst on %s and cannot be set through this action."), *Property, *ClassNameOf(Resolved.Instance)));
			}

			FString Previous;
			const bool bHadPrevious = ReadPropertySummary(Resolved.Instance, Property, Previous);

			FScopedEditorTransaction Transaction(FString::Printf(TEXT("UEV set behavior tree property: %s"), *Property));
			Tree->Modify();
			Binding.Graph->Modify();
			{
				FScopedGraphLock Lock(Binding.Graph);
				if (!UEVGraph::SetObjectPropertyPath(Resolved.Instance, Property, Value, Error))
				{
					return MakeFailure(Error);
				}
			}
			Resolved.Instance->PostEditChange();

			FString Current;
			const bool bReadable = ReadPropertySummary(Resolved.Instance, Property, Current);
			const FString Requested = ValueToText(Value);
			FJsonObjectPtr Result = UEVGraph::MakeSuccess();
			Result->SetStringField(TEXT("node_id"), Resolved.Id);
			Result->SetStringField(TEXT("property"), Property);
			Result->SetStringField(TEXT("previous"), Previous);
			Result->SetStringField(TEXT("current"), Current);
			Result->SetStringField(TEXT("requested"), Requested);
			Result->SetBoolField(TEXT("applied"), true);
			Result->SetBoolField(TEXT("verified"), bReadable && (Current.Equals(Requested, ESearchCase::IgnoreCase) || !Current.Equals(Previous, ESearchCase::CaseSensitive)));
			TArray<FString> Issues;
			if (!bReadable)
			{
				Issues.Add(FString::Printf(TEXT("Property %s was set but cannot be read back for verification (unsupported property type or composite path)."), *Property));
			}
			else if (!bHadPrevious)
			{
				Issues.Add(FString::Printf(TEXT("Previous value of %s could not be read."), *Property));
			}
			return FinishMutation(Binding, Args, Result, Issues);
		}

		// ------------------------------------------------------------------
		// bt_add_decorator / bt_add_service
		// ------------------------------------------------------------------
		FJsonObjectPtr AddSubNodeOp(const FJsonObject& Args, bool bDecorator)
		{
			const FString Noun = bDecorator ? TEXT("decorator") : TEXT("service");
			if (FJsonObjectPtr Guard = PieGuard(FString::Printf(TEXT("add a behavior tree %s"), *Noun)))
			{
				return Guard;
			}
			FString Error;
			UBehaviorTree* Tree = LoadBehaviorTree(Args, Error);
			if (!Tree)
			{
				return MakeFailure(Error);
			}
			const FString RequestedClass = UEVGraph::GetString(Args, bDecorator ? TEXT("decorator_class") : TEXT("service_class"));
			if (RequestedClass.IsEmpty())
			{
				return MakeFailure(FString::Printf(TEXT("%s_class is required."), *Noun));
			}
			UClass* InstanceClass = UEVGraph::ResolveClass(RequestedClass, bDecorator ? UBTDecorator::StaticClass() : UBTService::StaticClass(), Error);
			if (!InstanceClass)
			{
				return MakeFailure(Error);
			}
			if (InstanceClass->HasAnyClassFlags(CLASS_Abstract))
			{
				return MakeFailure(FString::Printf(TEXT("Class %s is abstract and cannot be added."), *InstanceClass->GetName()));
			}
			const FString LogicOp = UEVGraph::GetString(Args, TEXT("logic_op"), TEXT("test")).ToLower();
			if (bDecorator && !LogicOp.IsEmpty() && LogicOp != TEXT("test"))
			{
				return MakeFailure(TEXT("logic_op other than test is not supported in 1.7: several decorators on one node are combined with AND. Add them with separate bt_add_decorator calls."));
			}

			FScopedEditorTransaction Transaction(FString::Printf(TEXT("UEV add behavior tree %s: %s"), *Noun, *InstanceClass->GetName()));
			FGraphBinding Binding;
			if (!BindGraph(Tree, Binding, Error))
			{
				return MakeFailure(Error);
			}
			FResolvedNode Owner;
			if (!ResolveNodeRef(Binding, UEVGraph::GetString(Args, TEXT("node_id")), Owner, Error))
			{
				return MakeFailure(Error);
			}
			if (!Owner.GraphNode)
			{
				return MakeFailure(FString::Printf(TEXT("%s has no graph node and cannot take a %s."), *Owner.Id, *Noun));
			}
			Tree->Modify();
			Binding.Graph->Modify();

			TArray<FString> PropertyErrors;
			UAIGraphNode* Created = nullptr;
			{
				FScopedGraphLock Lock(Binding.Graph);
				Created = SpawnSubGraphNode(
					Binding,
					Owner.GraphNode,
					InstanceClass,
					LoadClassPath(bDecorator ? DecoratorGraphNodeClassPath : ServiceGraphNodeClassPath),
					Error);
				if (!Created)
				{
					return MakeFailure(Error);
				}
				const TSharedPtr<FJsonObject>* Properties = nullptr;
				if (Args.TryGetObjectField(TEXT("properties"), Properties) && Properties && Properties->IsValid())
				{
					ApplyProperties(Created->NodeInstance, **Properties, PropertyErrors);
				}
				const double RequestedIndex = UEVGraph::GetNumber(Args, TEXT("index"), -1.0);
				if (RequestedIndex >= 0.0)
				{
					ReorderSubNodeArray(Owner.GraphNode, bDecorator ? TEXT("Decorators") : TEXT("Services"), Created, FMath::RoundToInt(RequestedIndex));
				}
			}

			const FString GraphNodeId = UEVGraph::NodeId(Created);
			FJsonObjectPtr Result = UEVGraph::MakeSuccess();
			Result->SetStringField(TEXT("owner_id"), Owner.Id);
			Result->SetStringField(TEXT("class"), ClassPathOf(Created->NodeInstance));
			Result->SetStringField(TEXT("class_name"), ClassNameOf(Created->NodeInstance));
			Result->SetStringField(TEXT("graph_node_id"), GraphNodeId);
			Result->SetBoolField(TEXT("created"), true);
			Result->SetArrayField(TEXT("property_errors"), MakeStringArray(PropertyErrors));
			if (bDecorator)
			{
				Result->SetStringField(TEXT("logic_op"), TEXT("test"));
			}

			FJsonObjectPtr Done = FinishMutation(Binding, Args, Result, PropertyErrors);
			Done->SetStringField(bDecorator ? TEXT("decorator_id") : TEXT("service_id"), FindEntryIdByGraphNode(Done, bDecorator ? TEXT("decorators") : TEXT("services"), GraphNodeId));
			return Done;
		}

		// ------------------------------------------------------------------
		// bt_remove_decorator / bt_remove_service
		// ------------------------------------------------------------------
		FJsonObjectPtr RemoveSubNodeOp(const FJsonObject& Args, bool bDecorator)
		{
			const FString Noun = bDecorator ? TEXT("decorator") : TEXT("service");
			if (FJsonObjectPtr Guard = PieGuard(FString::Printf(TEXT("remove a behavior tree %s"), *Noun)))
			{
				return Guard;
			}
			FString Error;
			UBehaviorTree* Tree = LoadBehaviorTree(Args, Error);
			if (!Tree)
			{
				return MakeFailure(Error);
			}
			FGraphBinding Binding;
			if (!BindGraph(Tree, Binding, Error))
			{
				return MakeFailure(Error);
			}
			FResolvedNode Resolved;
			if (!ResolveNodeRef(Binding, UEVGraph::GetString(Args, TEXT("node_id")), Resolved, Error))
			{
				return MakeFailure(Error);
			}
			const FString ExpectedKind = bDecorator ? TEXT("decorator") : TEXT("service");
			if (Resolved.Kind != ExpectedKind)
			{
				return MakeFailure(FString::Printf(TEXT("%s is a %s node; use bt_remove_%s with a %s id such as %s/%c0."),
					*Resolved.Id, *Resolved.Kind, Resolved.Kind == TEXT("decorator") ? TEXT("decorator") : TEXT("service"), *Noun, *Resolved.Id, bDecorator ? TEXT('d') : TEXT('s')));
			}

			TArray<FString> RemovedIds;
			{
				TSet<const UBTNode*> Wanted;
				TArray<UBTNode*> Collected;
				TSet<const UBTNode*> Seen;
				CollectTreeNodes(Resolved.Instance, Collected, Seen);
				for (UBTNode* Node : Collected)
				{
					Wanted.Add(Node);
				}
				CollectIdsForInstances(Binding, Wanted, RemovedIds);
			}

			FScopedEditorTransaction Transaction(FString::Printf(TEXT("UEV remove behavior tree %s"), *Noun));
			Tree->Modify();
			Binding.Graph->Modify();
			{
				FScopedGraphLock Lock(Binding.Graph);
				if (UAIGraphNode* OwnerNode = Resolved.GraphNode->ParentNode)
				{
					OwnerNode->RemoveSubNode(Resolved.GraphNode);
				}
				DestroyGraphNodeRecursive(Binding, Resolved.GraphNode);
			}

			FJsonObjectPtr Result = UEVGraph::MakeSuccess();
			Result->SetStringField(TEXT("node_id"), Resolved.Id);
			Result->SetArrayField(TEXT("removed_ids"), MakeStringArray(RemovedIds));
			Result->SetBoolField(TEXT("removed"), true);
			return FinishMutation(Binding, Args, Result);
		}

		// ------------------------------------------------------------------
		// bt_set_blackboard
		// ------------------------------------------------------------------
		FJsonObjectPtr OpSetBlackboard(const FJsonObject& Args)
		{
			if (FJsonObjectPtr Guard = PieGuard(TEXT("set a behavior tree blackboard")))
			{
				return Guard;
			}
			FString Error;
			UBehaviorTree* Tree = LoadBehaviorTree(Args, Error);
			if (!Tree)
			{
				return MakeFailure(Error);
			}
			const FString BlackboardRef = UEVGraph::GetString(Args, TEXT("blackboard_path")).TrimStartAndEnd();
			UBlackboardData* Blackboard = nullptr;
			if (!BlackboardRef.IsEmpty() && !BlackboardRef.Equals(TEXT("None"), ESearchCase::IgnoreCase))
			{
				UObject* Asset = UEVGraph::LoadAsset(BlackboardRef, UBlackboardData::StaticClass(), Error);
				if (!Asset)
				{
					return MakeFailure(Error);
				}
				Blackboard = Cast<UBlackboardData>(Asset);
			}

			FScopedEditorTransaction Transaction(TEXT("UEV set behavior tree blackboard"));
			FGraphBinding Binding;
			if (!BindGraph(Tree, Binding, Error))
			{
				return MakeFailure(Error);
			}
			Tree->Modify();
			Binding.Graph->Modify();
			{
				FScopedGraphLock Lock(Binding.Graph);
				Tree->BlackboardAsset = Blackboard;
				if (Binding.RootGraphNode)
				{
					SetObjectPropertyByName(Binding.RootGraphNode, TEXT("BlackboardAsset"), Blackboard);
				}
				// Blackboard key indices are resolved per node, so every instance must re-read them.
				TArray<UAIGraphNode*> All;
				CollectAllGraphNodes(Binding.Graph, All);
				for (UAIGraphNode* GraphNode : All)
				{
					if (UBTNode* Instance = Cast<UBTNode>(GraphNode->NodeInstance))
					{
						Instance->InitializeFromAsset(*Tree);
					}
				}
				for (UBTDecorator* Decorator : Tree->RootDecorators)
				{
					if (Decorator)
					{
						Decorator->InitializeFromAsset(*Tree);
					}
				}
			}

			FJsonObjectPtr Result = UEVGraph::MakeSuccess();
			Result->SetStringField(TEXT("blackboard_path"), Blackboard ? Blackboard->GetPathName() : FString());
			Result->SetBoolField(TEXT("blackboard_cleared"), Blackboard == nullptr);
			FJsonObjectPtr Done = FinishMutation(Binding, Args, Result);
			if (Binding.RootGraphNode)
			{
				FString GraphRootBlackboard;
				ReadPropertySummary(Binding.RootGraphNode, TEXT("BlackboardAsset"), GraphRootBlackboard);
				Done->SetStringField(TEXT("graph_root_blackboard"), GraphRootBlackboard);
			}
			return Done;
		}

		// ------------------------------------------------------------------
		// bt_compile
		// ------------------------------------------------------------------
		FJsonObjectPtr OpCompile(const FJsonObject& Args)
		{
			if (FJsonObjectPtr Guard = PieGuard(TEXT("compile a behavior tree graph")))
			{
				return Guard;
			}
			FString Error;
			UBehaviorTree* Tree = LoadBehaviorTree(Args, Error);
			if (!Tree)
			{
				return MakeFailure(Error);
			}
			FGraphBinding Binding;
			Binding.Tree = Tree;
			Binding.Graph = Cast<UAIGraph>(Tree->BTGraph);
			Binding.RootGraphNode = FindRootGraphNode(Binding.Graph);
			if (!Binding.Graph)
			{
				return MakeFailure(TEXT("This behavior tree has no editor graph to compile from. Use bt_repair_graph to build one from the compiled tree, or bt_add_node to author the tree."));
			}
			if (!RootCompositeGraphNode(Binding.RootGraphNode))
			{
				return MakeFailure(TEXT("The behavior tree graph has no root node linked. Add a composite with bt_add_node (no parent_id) first."));
			}

			FScopedEditorTransaction Transaction(TEXT("UEV compile behavior tree graph"));
			Tree->Modify();
			Binding.Graph->Modify();

			FJsonObjectPtr Result = UEVGraph::MakeSuccess();
			Result->SetBoolField(TEXT("compiled"), true);
			TArray<FString> Issues;
			if (!Tree->BlackboardAsset)
			{
				Issues.Add(TEXT("The behavior tree has no blackboard asset assigned; blackboard keys cannot resolve."));
			}
			FJsonObjectPtr Done = FinishMutation(Binding, Args, Result, Issues);
			// PopulateStructure already reports tree_node_count / execution_index_max; mirror the
			// node count under the name the design document uses for bt_compile.
			Done->SetNumberField(TEXT("node_count"), Done->GetNumberField(TEXT("tree_node_count")));
			if (UBTCompositeNode* RootComposite = Cast<UBTCompositeNode>(Tree->RootNode))
			{
				Done->SetNumberField(TEXT("root_children"), RootComposite->Children.Num());
			}
			return Done;
		}

		// ------------------------------------------------------------------
		// bt_repair_graph
		// ------------------------------------------------------------------
		FJsonObjectPtr OpRepairGraph(const FJsonObject& Args)
		{
			if (FJsonObjectPtr Guard = PieGuard(TEXT("repair a behavior tree graph")))
			{
				return Guard;
			}
			FString Error;
			UBehaviorTree* Tree = LoadBehaviorTree(Args, Error);
			if (!Tree)
			{
				return MakeFailure(Error);
			}
			// Recovery case: 1.7.0 builds saved graphs whose mirrored root lost its instance (the old
			// repair path moved the graph, and every node instance it owned, into the transient
			// package). The compiled root is gone but the saved graph still links the root pin to a
			// composite node with a null instance, which crashes the editor when a human opens the
			// asset. Re-instantiate that node so the asset is openable again.
			UAIGraphNode* MissingRootTarget = nullptr;
			if (!Tree->RootNode)
			{
				if (UEdGraph* ExistingGraph = Tree->BTGraph)
				{
					UAIGraphNode* ExistingRootNode = FindRootGraphNode(Cast<UAIGraph>(ExistingGraph));
					UAIGraphNode* Candidate = RootCompositeGraphNode(ExistingRootNode);
					if (Candidate && !Cast<UBTCompositeNode>(Candidate->NodeInstance))
					{
						MissingRootTarget = Candidate;
					}
				}
				if (!MissingRootTarget)
				{
					return MakeFailure(TEXT("The behavior tree has no compiled root node, so there is nothing to mirror into a graph. Author the tree first with bt_add_node."));
				}
			}

			TArray<UBTNode*> Before;
			CollectAllTreeNodes(Tree, Before);

			FScopedEditorTransaction Transaction(TEXT("UEV repair behavior tree graph"));
			FString RebuiltRootClass;
			if (MissingRootTarget)
			{
				FString RootClassRef = UEVGraph::GetString(Args, TEXT("root_class"));
				if (RootClassRef.IsEmpty())
				{
					RootClassRef = TEXT("/Script/AIModule.BTComposite_Selector");
				}
				UClass* RootClass = UEVGraph::ResolveClass(RootClassRef, UBTCompositeNode::StaticClass(), Error);
				if (!RootClass)
				{
					return MakeFailure(Error);
				}
				if (RootClass->HasAnyClassFlags(CLASS_Abstract))
				{
					return MakeFailure(FString::Printf(TEXT("Class %s is abstract and cannot be the root node."), *RootClass->GetName()));
				}
				UObject* Instance = NewObject<UObject>(Tree->BTGraph, RootClass);
				if (!Instance)
				{
					return MakeFailure(FString::Printf(TEXT("Could not create a replacement root instance of class %s."), *RootClass->GetName()));
				}
				Instance->SetFlags(RF_Transactional);
				Tree->Modify();
				Tree->BTGraph->Modify();
				MissingRootTarget->Modify();
				MissingRootTarget->NodeInstance = Instance;
				MissingRootTarget->InitializeInstance();
				if (UBTNode* BTInstance = Cast<UBTNode>(Instance))
				{
					BTInstance->InitializeFromAsset(*Tree);
				}
				if (UAIGraph* ExistingGraph = Cast<UAIGraph>(Tree->BTGraph))
				{
					ExistingGraph->UpdateAsset(0);
				}
				RebuiltRootClass = RootClass->GetName();
				if (!Tree->RootNode)
				{
					return MakeFailure(TEXT("The saved graph root node still does not compile into a behavior tree root. The asset may need to be deleted and authored again."));
				}
			}

			FGraphBinding Binding;
			Binding.Tree = Tree;
			if (!CreateBehaviorTreeGraph(Binding, Error))
			{
				return MakeFailure(Error);
			}
			Binding.Graph->UpdateAsset(0);
			LayoutGraph(Binding);

			TArray<UBTNode*> After;
			CollectAllTreeNodes(Tree, After);

			FJsonObjectPtr Result = UEVGraph::MakeSuccess();
			Result->SetBoolField(TEXT("rebuilt"), true);
			Result->SetNumberField(TEXT("tree_node_count_before"), Before.Num());
			Result->SetNumberField(TEXT("tree_node_count_after"), After.Num());
			TArray<FString> Issues;
			if (Before.Num() != After.Num())
			{
				Issues.Add(FString::Printf(TEXT("The rebuilt tree has %d nodes but had %d before; review the graph and the compiled tree."), After.Num(), Before.Num()));
			}
			if (!RebuiltRootClass.IsEmpty())
			{
				Result->SetBoolField(TEXT("recreated_missing_root"), true);
				Result->SetStringField(TEXT("root_class"), RebuiltRootClass);
				Issues.Add(FString::Printf(
					TEXT("The saved graph root node had no node instance; it was recreated as %s. Re-check its children and compile the tree."),
					*RebuiltRootClass));
			}
			FJsonObjectPtr Done = FinishMutation(Binding, Args, Result, Issues);
			Done->SetBoolField(TEXT("graph_rebuilt"), true);
			if (!RebuiltRootClass.IsEmpty())
			{
				Done->SetBoolField(TEXT("recreated_missing_root"), true);
				Done->SetStringField(TEXT("root_class"), RebuiltRootClass);
			}
			return Done;
		}

		// ------------------------------------------------------------------
		// Dispatch
		// ------------------------------------------------------------------
		FJsonObjectPtr HandleOperation(const FString& RawOperation, const FJsonObject& Args)
		{
			FString Operation = RawOperation.TrimStartAndEnd().ToLower();
			if (Operation.StartsWith(TEXT("manage_ai.")))
			{
				Operation = Operation.RightChop(9);
			}
			if (Operation.StartsWith(TEXT("bt.")))
			{
				Operation = FString(TEXT("bt_")) + Operation.RightChop(3);
			}
			else if (Operation == TEXT("inspect_behavior_tree_graph") || Operation == TEXT("inspect_bt_graph"))
			{
				Operation = TEXT("bt_inspect");
			}

			if (Operation == TEXT("bt_inspect"))
			{
				return OpInspect(Args);
			}
			if (Operation == TEXT("bt_create"))
			{
				return OpCreate(Args);
			}
			if (Operation == TEXT("bt_add_node"))
			{
				return OpAddNode(Args);
			}
			if (Operation == TEXT("bt_remove_node"))
			{
				return OpRemoveNode(Args);
			}
			if (Operation == TEXT("bt_move_node"))
			{
				return OpMoveNode(Args);
			}
			if (Operation == TEXT("bt_set_node_property"))
			{
				return OpSetNodeProperty(Args);
			}
			if (Operation == TEXT("bt_add_decorator"))
			{
				return AddSubNodeOp(Args, true);
			}
			if (Operation == TEXT("bt_remove_decorator"))
			{
				return RemoveSubNodeOp(Args, true);
			}
			if (Operation == TEXT("bt_add_service"))
			{
				return AddSubNodeOp(Args, false);
			}
			if (Operation == TEXT("bt_remove_service"))
			{
				return RemoveSubNodeOp(Args, false);
			}
			if (Operation == TEXT("bt_set_blackboard"))
			{
				return OpSetBlackboard(Args);
			}
			if (Operation == TEXT("bt_compile"))
			{
				return OpCompile(Args);
			}
			if (Operation == TEXT("bt_repair_graph"))
			{
				return OpRepairGraph(Args);
			}
			return MakeFailure(FString::Printf(
				TEXT("Unknown behavior tree operation: %s. Supported operations: bt_create, bt_inspect, bt_add_node, bt_remove_node, bt_move_node, bt_set_node_property, bt_add_decorator, bt_remove_decorator, bt_add_service, bt_remove_service, bt_set_blackboard, bt_compile, bt_repair_graph."),
				*RawOperation));
		}
	} // namespace

	FString ExecuteBehaviorTreeOperation(const FString& Operation, const FString& ArgsJson)
	{
		TSharedPtr<FJsonObject> Args;
		if (!ArgsJson.TrimStartAndEnd().IsEmpty())
		{
			const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(ArgsJson);
			if (!FJsonSerializer::Deserialize(Reader, Args))
			{
				return UEVGraph::Serialize(MakeFailure(TEXT("Could not parse behavior tree arguments JSON.")));
			}
		}
		if (!Args.IsValid())
		{
			Args = MakeShared<FJsonObject>();
		}
		return UEVGraph::Serialize(HandleOperation(Operation, *Args));
	}
}

FString UUEVGraphAI::ExecuteAIOperation(const FString& Operation, const FString& ArgsJson)
{
	FString Normalized = Operation.TrimStartAndEnd().ToLower();
	if (Normalized.StartsWith(TEXT("manage_ai.")))
	{
		Normalized = Normalized.RightChop(10);
	}

	static const TCHAR* const SupportedOperations[] = {
		TEXT("bt_create"),
		TEXT("bt_inspect"),
		TEXT("bt_add_node"),
		TEXT("bt_remove_node"),
		TEXT("bt_move_node"),
		TEXT("bt_set_node_property"),
		TEXT("bt_add_decorator"),
		TEXT("bt_remove_decorator"),
		TEXT("bt_add_service"),
		TEXT("bt_remove_service"),
		TEXT("bt_set_blackboard"),
		TEXT("bt_compile"),
		TEXT("bt_repair_graph")
	};

	for (const TCHAR* Candidate : SupportedOperations)
	{
		if (Normalized == Candidate)
		{
			return UEVGraphBT::ExecuteBehaviorTreeOperation(Normalized, ArgsJson);
		}
	}
	return UEVGraph::Serialize(UEVGraph::MakeErrorObject(FString::Printf(
		TEXT("Unknown AI operation: %s. Behavior tree graph authoring operations are bt_create, bt_inspect, bt_add_node, bt_remove_node, bt_move_node, bt_set_node_property, bt_add_decorator, bt_remove_decorator, bt_add_service, bt_remove_service, bt_set_blackboard, bt_compile and bt_repair_graph."),
		*Operation)));
}
