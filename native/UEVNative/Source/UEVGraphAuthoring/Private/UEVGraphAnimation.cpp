#include "UEVGraphShared.h"

#include "AnimGraphNode_LayeredBoneBlend.h"
#include "AnimGraphNode_SequenceEvaluator.h"
#include "AnimGraphNode_SequencePlayer.h"
#include "AnimGraphNode_Slot.h"
#include "AnimGraphNode_StateMachine.h"
#include "AnimGraphNode_StateMachineBase.h"
#include "AnimGraphNode_TwoWayBlend.h"
#include "AnimStateConduitNode.h"
#include "AnimStateEntryNode.h"
#include "AnimStateNode.h"
#include "AnimStateNodeBase.h"
#include "AnimStateTransitionNode.h"
#include "AlphaBlend.h"
#include "AnimationGraph.h"
#include "AnimationStateGraph.h"
#include "AnimationStateMachineGraph.h"
#include "AnimationStateMachineSchema.h"
#include "AnimationTransitionGraph.h"
#include "Animation/BlendProfile.h"
#include "AnimationBlueprintLibrary.h"
#include "Curves/CurveFloat.h"
#include "EdGraphSchema_K2.h"
#include "K2Node_CallFunction.h"
#include "K2Node_IfThenElse.h"
#include "K2Node_Literal.h"
#include "K2Node_VariableGet.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "UObject/UnrealType.h"

namespace UEVGraph
{
	namespace
	{
		FVector2D AnimPosition(const FJsonObject& Args)
		{
			const TArray<TSharedPtr<FJsonValue>>* Position = GetArray(Args, TEXT("node_position"));
			if (Position && Position->Num() >= 2)
			{
				return FVector2D((*Position)[0]->AsNumber(), (*Position)[1]->AsNumber());
			}
			return FVector2D(GetNumber(Args, TEXT("x"), 0.0), GetNumber(Args, TEXT("y"), 0.0));
		}

		void PlaceAnimNode(UEdGraphNode* Node, const FVector2D& Position)
		{
			if (Node)
			{
				Node->NodePosX = static_cast<int32>(Position.X);
				Node->NodePosY = static_cast<int32>(Position.Y);
			}
		}

		template <typename NodeType>
		NodeType* CreateAnimNode(UEdGraph* Graph, const FVector2D& Position, TFunctionRef<void(NodeType*)> Configure, FString& OutError)
		{
			FGraphNodeCreator<NodeType> Creator(*Graph);
			NodeType* Node = Creator.CreateNode(false);
			if (!Node)
			{
				OutError = TEXT("Failed to create AnimGraph node.");
				return nullptr;
			}
			Configure(Node);
			PlaceAnimNode(Node, Position);
			Creator.Finalize();
			return Node;
		}

		UEdGraph* RootAnimGraph(UAnimBlueprint* AnimBlueprint)
		{
			if (!AnimBlueprint)
			{
				return nullptr;
			}
			UEdGraph* Graph = FindGraphByName(AnimBlueprint, TEXT("AnimGraph"));
			if (Graph)
			{
				return Graph;
			}
			for (UEdGraph* Candidate : AnimBlueprint->FunctionGraphs)
			{
				if (Cast<UAnimationGraph>(Candidate))
				{
					return Candidate;
				}
			}
			return nullptr;
		}

		UEdGraph* SelectAnimGraph(UAnimBlueprint* AnimBlueprint, const FJsonObject& Args, FString& OutError)
		{
			const FString GraphNodeId = GetString(Args, TEXT("graph_node_id"));
			if (GraphNodeId.IsEmpty())
			{
				UEdGraph* Root = RootAnimGraph(AnimBlueprint);
				if (!Root)
				{
					OutError = TEXT("AnimGraph not found.");
				}
				return Root;
			}
			UEdGraphNode* Node = FindNode(AnimBlueprint, GraphNodeId);
			if (!Node)
			{
				OutError = FString::Printf(TEXT("Graph node not found: %s"), *GraphNodeId);
				return nullptr;
			}
			if (UAnimGraphNode_StateMachineBase* StateMachine = Cast<UAnimGraphNode_StateMachineBase>(Node))
			{
				return StateMachine->EditorStateMachineGraph;
			}
			if (UAnimStateNode* State = Cast<UAnimStateNode>(Node))
			{
				return State->BoundGraph;
			}
			if (UAnimStateTransitionNode* Transition = Cast<UAnimStateTransitionNode>(Node))
			{
				const bool bCustom = GetString(Args, TEXT("graph_kind")).Equals(TEXT("custom_transition"), ESearchCase::IgnoreCase);
				return bCustom ? Transition->CustomTransitionGraph : Transition->BoundGraph;
			}
			OutError = TEXT("The selected node does not own an animation graph.");
			return nullptr;
		}

		UAnimGraphNode_StateMachineBase* FindStateMachine(UAnimBlueprint* AnimBlueprint, const FString& NodeIdValue, FString& OutError)
		{
			UAnimGraphNode_StateMachineBase* StateMachine = Cast<UAnimGraphNode_StateMachineBase>(FindNode(AnimBlueprint, NodeIdValue));
			if (!StateMachine)
			{
				OutError = FString::Printf(TEXT("State machine node not found: %s"), *NodeIdValue);
			}
			return StateMachine;
		}

		UAnimStateNode* FindState(UAnimBlueprint* AnimBlueprint, const FString& NodeIdValue, FString& OutError)
		{
			UAnimStateNode* State = Cast<UAnimStateNode>(FindNode(AnimBlueprint, NodeIdValue));
			if (!State)
			{
				OutError = FString::Printf(TEXT("State node not found: %s"), *NodeIdValue);
			}
			return State;
		}

		UAnimStateTransitionNode* FindTransition(UAnimBlueprint* AnimBlueprint, const FString& NodeIdValue, FString& OutError)
		{
			UAnimStateTransitionNode* Transition = Cast<UAnimStateTransitionNode>(FindNode(AnimBlueprint, NodeIdValue));
			if (!Transition)
			{
				OutError = FString::Printf(TEXT("Transition node not found: %s"), *NodeIdValue);
			}
			return Transition;
		}

		FString BlendModeName(EAlphaBlendOption Mode)
		{
			switch (Mode)
			{
			case EAlphaBlendOption::Linear: return TEXT("linear");
			case EAlphaBlendOption::Cubic: return TEXT("cubic");
			case EAlphaBlendOption::HermiteCubic: return TEXT("hermite_cubic");
			case EAlphaBlendOption::Sinusoidal: return TEXT("sinusoidal");
			case EAlphaBlendOption::QuadraticInOut: return TEXT("quadratic_in_out");
			case EAlphaBlendOption::CubicInOut: return TEXT("cubic_in_out");
			case EAlphaBlendOption::QuarticInOut: return TEXT("quartic_in_out");
			case EAlphaBlendOption::QuinticInOut: return TEXT("quintic_in_out");
			case EAlphaBlendOption::CircularIn: return TEXT("circular_in");
			case EAlphaBlendOption::CircularOut: return TEXT("circular_out");
			case EAlphaBlendOption::CircularInOut: return TEXT("circular_in_out");
			case EAlphaBlendOption::ExpIn: return TEXT("exp_in");
			case EAlphaBlendOption::ExpOut: return TEXT("exp_out");
			case EAlphaBlendOption::ExpInOut: return TEXT("exp_in_out");
			case EAlphaBlendOption::Custom: return TEXT("custom");
			default: return TEXT("linear");
			}
		}

		FJsonObjectPtr SerializeReflectedProperty(FProperty* Property, void* ValuePtr, UObject* Owner, int32 Depth)
		{
			FJsonObjectPtr Result = MakeObject();
			if (!Property || !ValuePtr)
			{
				return Result;
			}
			Result->SetStringField(TEXT("name"), Property->GetName());
			Result->SetStringField(TEXT("type"), Property->GetClass()->GetName());
			Result->SetStringField(TEXT("cpp_type"), Property->GetCPPType());
			Result->SetBoolField(TEXT("editable"), (Property->PropertyFlags & CPF_Edit) != 0);

			FString ValueText;
			Property->ExportTextItem(ValueText, ValuePtr, nullptr, Owner, PPF_None);
			Result->SetStringField(TEXT("value"), ValueText);

			if (FEnumProperty* EnumProperty = CastField<FEnumProperty>(Property))
			{
				if (UEnum* Enum = EnumProperty->GetEnum())
				{
					Result->SetStringField(TEXT("enum"), Enum->GetName());
				}
			}
			else if (FByteProperty* ByteProperty = CastField<FByteProperty>(Property))
			{
				if (ByteProperty->Enum)
				{
					Result->SetStringField(TEXT("enum"), ByteProperty->Enum->GetName());
				}
			}
			else if (FArrayProperty* ArrayProperty = CastField<FArrayProperty>(Property))
			{
				Result->SetStringField(TEXT("element_type"), ArrayProperty->Inner ? ArrayProperty->Inner->GetClass()->GetName() : FString());
			}
			else if (FSetProperty* SetProperty = CastField<FSetProperty>(Property))
			{
				Result->SetStringField(TEXT("element_type"), SetProperty->ElementProp ? SetProperty->ElementProp->GetClass()->GetName() : FString());
			}
			else if (FMapProperty* MapProperty = CastField<FMapProperty>(Property))
			{
				Result->SetStringField(TEXT("key_type"), MapProperty->KeyProp ? MapProperty->KeyProp->GetClass()->GetName() : FString());
				Result->SetStringField(TEXT("value_type"), MapProperty->ValueProp ? MapProperty->ValueProp->GetClass()->GetName() : FString());
			}
			else if (FStructProperty* StructProperty = CastField<FStructProperty>(Property))
			{
				Result->SetStringField(TEXT("struct"), StructProperty->Struct ? StructProperty->Struct->GetName() : FString());
				if (Depth < 2)
				{
					TArray<TSharedPtr<FJsonValue>> Fields;
					for (TFieldIterator<FProperty> It(StructProperty->Struct); It; ++It)
					{
						FProperty* Child = *It;
						if (!Child || Child->HasAnyPropertyFlags(CPF_Transient | CPF_Deprecated))
						{
							continue;
						}
						Fields.Add(MakeShared<FJsonValueObject>(
							SerializeReflectedProperty(Child, Child->ContainerPtrToValuePtr<void>(ValuePtr), Owner, Depth + 1)));
					}
					Result->SetArrayField(TEXT("fields"), Fields);
				}
			}
			return Result;
		}

		bool ParseBlendMode(const FString& Text, EAlphaBlendOption& OutMode)
		{
			FString Value = Text.ToLower().Replace(TEXT("-"), TEXT("_")).Replace(TEXT(" "), TEXT("_"));
			if (Value == TEXT("linear")) OutMode = EAlphaBlendOption::Linear;
			else if (Value == TEXT("cubic")) OutMode = EAlphaBlendOption::Cubic;
			else if (Value == TEXT("hermite_cubic") || Value == TEXT("hermitecubic")) OutMode = EAlphaBlendOption::HermiteCubic;
			else if (Value == TEXT("sinusoidal")) OutMode = EAlphaBlendOption::Sinusoidal;
			else if (Value == TEXT("quadratic_in_out") || Value == TEXT("quadraticinout")) OutMode = EAlphaBlendOption::QuadraticInOut;
			else if (Value == TEXT("cubic_in_out") || Value == TEXT("cubicinout")) OutMode = EAlphaBlendOption::CubicInOut;
			else if (Value == TEXT("quartic_in_out") || Value == TEXT("quarticinout")) OutMode = EAlphaBlendOption::QuarticInOut;
			else if (Value == TEXT("quintic_in_out") || Value == TEXT("quinticinout")) OutMode = EAlphaBlendOption::QuinticInOut;
			else if (Value == TEXT("circular_in") || Value == TEXT("circularin")) OutMode = EAlphaBlendOption::CircularIn;
			else if (Value == TEXT("circular_out") || Value == TEXT("circularout")) OutMode = EAlphaBlendOption::CircularOut;
			else if (Value == TEXT("circular_in_out") || Value == TEXT("circularinout")) OutMode = EAlphaBlendOption::CircularInOut;
			else if (Value == TEXT("exp_in") || Value == TEXT("expin")) OutMode = EAlphaBlendOption::ExpIn;
			else if (Value == TEXT("exp_out") || Value == TEXT("expout")) OutMode = EAlphaBlendOption::ExpOut;
			else if (Value == TEXT("exp_in_out") || Value == TEXT("expinout")) OutMode = EAlphaBlendOption::ExpInOut;
			else if (Value == TEXT("custom")) OutMode = EAlphaBlendOption::Custom;
			else return false;
			return true;
		}

		FJsonObjectPtr SerializeStateMachine(UEdGraphNode* Node, UAnimGraphNode_StateMachineBase* StateMachine)
		{
			FJsonObjectPtr Result = MakeObject();
			Result->SetStringField(TEXT("node_id"), NodeId(Node));
			Result->SetStringField(TEXT("name"), StateMachine->GetStateMachineName());
			UAnimationStateMachineGraph* Graph = StateMachine->EditorStateMachineGraph;
			if (!Graph)
			{
				return Result;
			}
			Result->SetStringField(TEXT("graph"), Graph->GetName());
			Result->SetStringField(TEXT("entry_node_id"), Graph->EntryNode ? NodeId(Graph->EntryNode) : FString());

			TArray<TSharedPtr<FJsonValue>> States;
			TArray<TSharedPtr<FJsonValue>> Transitions;
			for (UEdGraphNode* GraphNode : Graph->Nodes)
			{
				if (UAnimStateNode* State = Cast<UAnimStateNode>(GraphNode))
				{
					FJsonObjectPtr StateObject = MakeObject();
					StateObject->SetStringField(TEXT("node_id"), NodeId(State));
					StateObject->SetStringField(TEXT("name"), State->GetStateName());
					StateObject->SetStringField(TEXT("graph"), State->BoundGraph ? State->BoundGraph->GetName() : FString());
					StateObject->SetBoolField(TEXT("always_reset_on_entry"), State->bAlwaysResetOnEntry);
					States.Add(MakeShared<FJsonValueObject>(StateObject));
				}
				else if (UAnimStateConduitNode* Conduit = Cast<UAnimStateConduitNode>(GraphNode))
				{
					FJsonObjectPtr StateObject = MakeObject();
					StateObject->SetStringField(TEXT("node_id"), NodeId(Conduit));
					StateObject->SetStringField(TEXT("name"), Conduit->GetStateName());
					StateObject->SetStringField(TEXT("graph"), Conduit->BoundGraph ? Conduit->BoundGraph->GetName() : FString());
					StateObject->SetStringField(TEXT("type"), TEXT("conduit"));
					States.Add(MakeShared<FJsonValueObject>(StateObject));
				}
				else if (UAnimStateTransitionNode* Transition = Cast<UAnimStateTransitionNode>(GraphNode))
				{
					FJsonObjectPtr TransitionObject = MakeObject();
					TransitionObject->SetStringField(TEXT("node_id"), NodeId(Transition));
					TransitionObject->SetStringField(TEXT("from"), Transition->GetPreviousState() ? Transition->GetPreviousState()->GetStateName() : FString());
					TransitionObject->SetStringField(TEXT("to"), Transition->GetNextState() ? Transition->GetNextState()->GetStateName() : FString());
					TransitionObject->SetNumberField(TEXT("priority"), Transition->PriorityOrder);
					TransitionObject->SetNumberField(TEXT("crossfade"), Transition->CrossfadeDuration);
					TransitionObject->SetStringField(TEXT("blend_mode"), BlendModeName(Transition->BlendMode));
					TransitionObject->SetStringField(TEXT("custom_blend_curve"), Transition->CustomBlendCurve ? Transition->CustomBlendCurve->GetPathName() : FString());
					TransitionObject->SetStringField(TEXT("blend_profile"), Transition->BlendProfile ? Transition->BlendProfile->GetPathName() : FString());
					TransitionObject->SetBoolField(TEXT("bidirectional"), Transition->Bidirectional);
					TransitionObject->SetBoolField(TEXT("automatic_rule"), Transition->bAutomaticRuleBasedOnSequencePlayerInState);
					TransitionObject->SetStringField(TEXT("graph"), Transition->BoundGraph ? Transition->BoundGraph->GetName() : FString());
					Transitions.Add(MakeShared<FJsonValueObject>(TransitionObject));
				}
			}
			Result->SetArrayField(TEXT("states"), States);
			Result->SetArrayField(TEXT("transitions"), Transitions);
			Result->SetObjectField(TEXT("graph_data"), SerializeGraph(Graph, true));
			return Result;
		}

		UEdGraphNode* AddRuleNode(UAnimBlueprint* AnimBlueprint, UEdGraph* Graph, const FJsonObject& Args, FString& OutError)
		{
			const FString NodeType = GetString(Args, TEXT("node_type")).ToLower();
			const FVector2D Position = AnimPosition(Args);
			if (NodeType == TEXT("branch"))
			{
				return CreateAnimNode<UK2Node_IfThenElse>(Graph, Position, [](UK2Node_IfThenElse*) {}, OutError);
			}
			if (NodeType == TEXT("function") || NodeType == TEXT("comparison"))
			{
				const FString FunctionName = GetString(Args, TEXT("function_name"));
				const FString Target = NodeType == TEXT("comparison")
					? TEXT("class:/Script/Engine.KismetMathLibrary")
					: GetString(Args, TEXT("target"), TEXT("self"));
				UClass* OwnerClass = ResolveFunctionOwner(AnimBlueprint, Target, OutError);
				if (!OwnerClass)
				{
					return nullptr;
				}
				UFunction* Function = FindFunction(OwnerClass, FunctionName);
				if (!Function)
				{
					OutError = FString::Printf(TEXT("Function not found: %s"), *FunctionName);
					return nullptr;
				}
				return CreateAnimNode<UK2Node_CallFunction>(Graph, Position, [&](UK2Node_CallFunction* CallNode)
				{
					CallNode->SetFromFunction(Function);
					CallNode->FunctionReference.SetExternalMember(Function->GetFName(), OwnerClass);
				}, OutError);
			}
			if (NodeType == TEXT("variable_get"))
			{
				const FString VariableName = GetString(Args, TEXT("variable_name"));
				return CreateAnimNode<UK2Node_VariableGet>(Graph, Position, [&](UK2Node_VariableGet* Node)
				{
					Node->VariableReference.SetSelfMember(FName(*VariableName));
				}, OutError);
			}
			if (NodeType == TEXT("literal"))
			{
				return CreateAnimNode<UK2Node_Literal>(Graph, Position, [&](UK2Node_Literal* Node)
				{
					const FString ObjectPath = GetString(Args, TEXT("object_path"));
					if (!ObjectPath.IsEmpty())
					{
						Node->SetObjectRef(LoadObject<UObject>(nullptr, *ObjectPath));
					}
				}, OutError);
			}
			if (NodeType == TEXT("raw"))
			{
				UClass* NodeClass = ResolveClass(GetString(Args, TEXT("node_class")), UEdGraphNode::StaticClass(), OutError);
				if (!NodeClass)
				{
					return nullptr;
				}
				UEdGraphNode* Node = NewObject<UEdGraphNode>(Graph, NodeClass, NAME_None, RF_Transactional);
				Graph->AddNode(Node, false, false);
				Node->CreateNewGuid();
				Node->PostPlacedNewNode();
				if (Node->Pins.Num() == 0)
				{
					Node->AllocateDefaultPins();
				}
				PlaceAnimNode(Node, Position);
				return Node;
			}
			OutError = FString::Printf(TEXT("Unsupported transition rule node type: %s"), *NodeType);
			return nullptr;
		}
	}

	FJsonObjectPtr HandleAnimationGraphOperationInternal(const FString& Operation, const FJsonObject& Args)
	{
		FString Error;
		if (Operation == TEXT("inspect_node_properties"))
		{
			UAnimBlueprint* AnimBlueprint = LoadAnimBlueprint(Args, Error);
			if (!AnimBlueprint)
			{
				return MakeErrorObject(Error);
			}
			UEdGraphNode* Node = FindNode(AnimBlueprint, GetString(Args, TEXT("node_id")));
			if (!Node)
			{
				return MakeErrorObject(TEXT("AnimGraph node not found."));
			}
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetStringField(TEXT("node_id"), NodeId(Node));
			Result->SetStringField(TEXT("class"), Node->GetClass()->GetName());
			TArray<TSharedPtr<FJsonValue>> Properties;
			for (TFieldIterator<FProperty> It(Node->GetClass()); It; ++It)
			{
				FProperty* Property = *It;
				if (!Property || Property->HasAnyPropertyFlags(CPF_Transient | CPF_Deprecated))
				{
					continue;
				}
				Properties.Add(MakeShared<FJsonValueObject>(
					SerializeReflectedProperty(Property, Property->ContainerPtrToValuePtr<void>(Node), Node, 0)));
			}
			Result->SetArrayField(TEXT("properties"), Properties);
			return Result;
		}

		if (Operation == TEXT("inspect_graph"))
		{
			UAnimBlueprint* AnimBlueprint = LoadAnimBlueprint(Args, Error);
			if (!AnimBlueprint)
			{
				return MakeErrorObject(Error);
			}
			UEdGraph* Root = SelectAnimGraph(AnimBlueprint, Args, Error);
			if (!Root)
			{
				return MakeErrorObject(Error);
			}
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetStringField(TEXT("asset_path"), AnimBlueprint->GetPathName());
			Result->SetObjectField(TEXT("graph"), SerializeGraph(Root, true));
			TArray<TSharedPtr<FJsonValue>> StateMachines;
			TArray<UEdGraph*> Graphs;
			AppendGraphs(AnimBlueprint, Graphs, true);
			for (UEdGraph* Graph : Graphs)
			{
				for (UEdGraphNode* Node : Graph->Nodes)
				{
					if (UAnimGraphNode_StateMachineBase* StateMachine = Cast<UAnimGraphNode_StateMachineBase>(Node))
					{
						StateMachines.Add(MakeShared<FJsonValueObject>(SerializeStateMachine(Node, StateMachine)));
					}
				}
			}
			Result->SetArrayField(TEXT("state_machines"), StateMachines);
			return Result;
		}

		if (Operation == TEXT("add_graph_node"))
		{
			UAnimBlueprint* AnimBlueprint = LoadAnimBlueprint(Args, Error);
			if (!AnimBlueprint)
			{
				return MakeErrorObject(Error);
			}
			UEdGraph* Graph = SelectAnimGraph(AnimBlueprint, Args, Error);
			if (!Graph)
			{
				return MakeErrorObject(Error);
			}
			AnimBlueprint->Modify();
			Graph->Modify();
			const FString NodeType = GetString(Args, TEXT("node_type")).ToLower();
			const FVector2D Position = AnimPosition(Args);
			UEdGraphNode* Node = nullptr;
			if (NodeType == TEXT("sequence_player"))
			{
				Node = CreateAnimNode<UAnimGraphNode_SequencePlayer>(Graph, Position, [](UAnimGraphNode_SequencePlayer*) {}, Error);
			}
			else if (NodeType == TEXT("sequence_evaluator"))
			{
				Node = CreateAnimNode<UAnimGraphNode_SequenceEvaluator>(Graph, Position, [](UAnimGraphNode_SequenceEvaluator*) {}, Error);
			}
			else if (NodeType == TEXT("two_way_blend") || NodeType == TEXT("blend"))
			{
				Node = CreateAnimNode<UAnimGraphNode_TwoWayBlend>(Graph, Position, [](UAnimGraphNode_TwoWayBlend*) {}, Error);
			}
			else if (NodeType == TEXT("layered_blend"))
			{
				Node = CreateAnimNode<UAnimGraphNode_LayeredBoneBlend>(Graph, Position, [](UAnimGraphNode_LayeredBoneBlend*) {}, Error);
			}
			else if (NodeType == TEXT("slot"))
			{
				Node = CreateAnimNode<UAnimGraphNode_Slot>(Graph, Position, [&](UAnimGraphNode_Slot* SlotNode)
				{
					SlotNode->Node.SlotName = FName(*GetString(Args, TEXT("slot_name"), TEXT("DefaultSlot")));
				}, Error);
			}
			else if (NodeType == TEXT("state_machine"))
			{
				Node = CreateAnimNode<UAnimGraphNode_StateMachine>(Graph, Position, [](UAnimGraphNode_StateMachine*) {}, Error);
			}
			else if (NodeType == TEXT("raw"))
			{
				UClass* NodeClass = ResolveClass(GetString(Args, TEXT("node_class")), UEdGraphNode::StaticClass(), Error);
				if (NodeClass)
				{
					Node = NewObject<UEdGraphNode>(Graph, NodeClass, NAME_None, RF_Transactional);
					Graph->AddNode(Node, false, false);
					Node->CreateNewGuid();
					Node->PostPlacedNewNode();
					if (Node->Pins.Num() == 0)
					{
						Node->AllocateDefaultPins();
					}
					PlaceAnimNode(Node, Position);
				}
			}
			else
			{
				Error = FString::Printf(TEXT("Unsupported AnimGraph node type: %s"), *NodeType);
			}
			if (!Node)
			{
				return MakeErrorObject(Error.IsEmpty() ? TEXT("Could not create AnimGraph node.") : Error);
			}

			const FString AnimAsset = GetString(Args, TEXT("anim_asset"));
			if (!AnimAsset.IsEmpty())
			{
				const TSharedPtr<FJsonValue> AssetValue = MakeShared<FJsonValueString>(AnimAsset);
				if (!SetObjectPropertyPath(Node, TEXT("Node.Sequence"), AssetValue, Error))
				{
					return MakeErrorObject(Error);
				}
			}
			const TSharedPtr<FJsonObject> Properties = GetObject(Args, TEXT("properties"));
			if (Properties.IsValid())
			{
				for (const auto& Pair : Properties->Values)
				{
					if (!SetObjectPropertyPath(Node, Pair.Key, Pair.Value, Error))
					{
						return MakeErrorObject(Error);
					}
				}
			}
			Node->ReconstructNode();
			FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(AnimBlueprint);
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetObjectField(TEXT("node"), SerializeNode(Node, Graph));
			return Result;
		}

		if (Operation == TEXT("set_node_property"))
		{
			UAnimBlueprint* AnimBlueprint = LoadAnimBlueprint(Args, Error);
			if (!AnimBlueprint)
			{
				return MakeErrorObject(Error);
			}
			UEdGraphNode* Node = FindNode(AnimBlueprint, GetString(Args, TEXT("node_id")));
			AnimBlueprint->Modify();
			if (Node) Node->Modify();
			const TSharedPtr<FJsonValue> Value = Args.TryGetField(TEXT("value"));
			if (!Node || !Value.IsValid() || !SetObjectPropertyPath(Node, GetString(Args, TEXT("property")), Value, Error))
			{
				return MakeErrorObject(Error.IsEmpty() ? TEXT("node_id, property, and value are required.") : Error);
			}
			Node->ReconstructNode();
			FBlueprintEditorUtils::MarkBlueprintAsModified(AnimBlueprint);
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetObjectField(TEXT("node"), SerializeNode(Node, Node->GetGraph()));
			return Result;
		}

		if (Operation == TEXT("connect_nodes") || Operation == TEXT("disconnect_nodes"))
		{
			UAnimBlueprint* AnimBlueprint = LoadAnimBlueprint(Args, Error);
			if (!AnimBlueprint)
			{
				return MakeErrorObject(Error);
			}
			const FString GraphName = GetString(Args, TEXT("graph_name")).TrimStartAndEnd();
			const FString NormalizedGraphName = GraphName.ToLower();
			UEdGraph* ScopeGraph = nullptr;
			if (!GraphName.IsEmpty())
			{
				ScopeGraph = FindGraphByName(AnimBlueprint, GraphName);
				if (!ScopeGraph && (NormalizedGraphName == TEXT("anim") || NormalizedGraphName == TEXT("animgraph")))
				{
					ScopeGraph = RootAnimGraph(AnimBlueprint);
				}
				if (!ScopeGraph)
				{
					return MakeErrorObject(FString::Printf(TEXT("Graph not found: %s"), *GraphName));
				}
			}
			const bool bGraphNamed = ScopeGraph != nullptr;
			const FString ScopeSuffix = bGraphNamed ? FString::Printf(TEXT(" in graph '%s'"), *ScopeGraph->GetName()) : FString();

			const FString SourceNodeId = GetString(Args, TEXT("source_node_id"));
			const FString TargetNodeId = GetString(Args, TEXT("target_node_id"));
			const FString SourcePinName = GetString(Args, TEXT("source_pin"));
			const FString TargetPinName = GetString(Args, TEXT("target_pin"));

			AnimBlueprint->Modify();
			UEdGraphNode* SourceNode = bGraphNamed ? FindNodeInGraph(ScopeGraph, SourceNodeId) : FindNode(AnimBlueprint, SourceNodeId);
			UEdGraphNode* TargetNode = bGraphNamed ? FindNodeInGraph(ScopeGraph, TargetNodeId) : FindNode(AnimBlueprint, TargetNodeId);
			if (!SourceNode)
			{
				return MakeErrorObject(FString::Printf(TEXT("Source node '%s' not found%s. Use inspect_graph to list node ids."), *SourceNodeId, *ScopeSuffix));
			}
			if (!TargetNode && Operation == TEXT("connect_nodes"))
			{
				return MakeErrorObject(FString::Printf(TEXT("Target node '%s' not found%s. Use inspect_graph to list node ids."), *TargetNodeId, *ScopeSuffix));
			}
			UEdGraphPin* SourcePin = FindPin(SourceNode, SourcePinName);
			UEdGraphPin* TargetPin = FindPin(TargetNode, TargetPinName);
			if (!SourcePin)
			{
				return MakeErrorObject(FString::Printf(TEXT("Source pin '%s' not found on node '%s'%s."), *SourcePinName, *SourceNodeId, *ScopeSuffix));
			}
			if (Operation == TEXT("connect_nodes") && !TargetPin)
			{
				return MakeErrorObject(FString::Printf(TEXT("Target pin '%s' not found on node '%s'%s."), *TargetPinName, *TargetNodeId, *ScopeSuffix));
			}
			if (Operation == TEXT("connect_nodes"))
			{
				if (!ConnectPins(SourcePin, TargetPin, Error))
				{
					return MakeErrorObject(Error);
				}
			}
			else
			{
				DisconnectPins(SourcePin, TargetPin, Error);
			}
			FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(AnimBlueprint);
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetStringField(TEXT("source_node_id"), NodeId(SourceNode));
			Result->SetStringField(TEXT("target_node_id"), NodeId(TargetNode));
			if (UEdGraph* ResolvedGraph = bGraphNamed ? ScopeGraph : SourceNode->GetGraph())
			{
				Result->SetStringField(TEXT("graph"), ResolvedGraph->GetName());
			}
			return Result;
		}

		if (Operation == TEXT("delete_node"))
		{
			UAnimBlueprint* AnimBlueprint = LoadAnimBlueprint(Args, Error);
			if (!AnimBlueprint)
			{
				return MakeErrorObject(Error);
			}
			const FString GraphName = GetString(Args, TEXT("graph_name")).TrimStartAndEnd();
			UEdGraph* ScopeGraph = GraphName.IsEmpty() ? nullptr : FindGraphByName(AnimBlueprint, GraphName);
			if (!GraphName.IsEmpty() && !ScopeGraph)
			{
				return MakeErrorObject(FString::Printf(TEXT("Graph not found: %s"), *GraphName));
			}
			const FString NodeIdValue = GetString(Args, TEXT("node_id"));
			UEdGraphNode* Node = ScopeGraph ? FindNodeInGraph(ScopeGraph, NodeIdValue) : FindNode(AnimBlueprint, NodeIdValue);
			if (!Node)
			{
				const FString ScopeSuffix = ScopeGraph ? FString::Printf(TEXT(" in graph '%s'"), *ScopeGraph->GetName()) : FString();
				return MakeErrorObject(FString::Printf(TEXT("Node '%s' not found%s. Use inspect_graph to list node ids."), *NodeIdValue, *ScopeSuffix));
			}
			UEdGraph* NodeGraph = Node->GetGraph();
			FBlueprintEditorUtils::RemoveNode(AnimBlueprint, Node, true);
			FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(AnimBlueprint);
			FJsonObjectPtr Result = MakeSuccess();
			if (NodeGraph)
			{
				Result->SetStringField(TEXT("graph"), NodeGraph->GetName());
			}
			return Result;
		}

		if (Operation == TEXT("add_state_machine"))
		{
			UAnimBlueprint* AnimBlueprint = LoadAnimBlueprint(Args, Error);
			if (!AnimBlueprint)
			{
				return MakeErrorObject(Error);
			}
			UEdGraph* Root = SelectAnimGraph(AnimBlueprint, Args, Error);
			if (!Root)
			{
				return MakeErrorObject(Error);
			}
			AnimBlueprint->Modify();
			Root->Modify();
			UAnimGraphNode_StateMachine* Node = CreateAnimNode<UAnimGraphNode_StateMachine>(
				Root, AnimPosition(Args), [](UAnimGraphNode_StateMachine*) {}, Error);
			if (!Node)
			{
				return MakeErrorObject(Error);
			}
			FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(AnimBlueprint);
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetStringField(TEXT("node_id"), NodeId(Node));
			Result->SetStringField(TEXT("graph"), Node->EditorStateMachineGraph ? Node->EditorStateMachineGraph->GetName() : FString());
			return Result;
		}

		if (Operation == TEXT("add_state") || Operation == TEXT("add_conduit"))
		{
			UAnimBlueprint* AnimBlueprint = LoadAnimBlueprint(Args, Error);
			if (!AnimBlueprint)
			{
				return MakeErrorObject(Error);
			}
			UAnimGraphNode_StateMachineBase* StateMachine = FindStateMachine(
				AnimBlueprint, GetString(Args, TEXT("state_machine_node_id")), Error);
			if (!StateMachine || !StateMachine->EditorStateMachineGraph)
			{
				return MakeErrorObject(Error);
			}
			UEdGraph* Graph = StateMachine->EditorStateMachineGraph;
			AnimBlueprint->Modify();
			Graph->Modify();
			UAnimStateNodeBase* NewState = Operation == TEXT("add_conduit")
				? static_cast<UAnimStateNodeBase*>(FEdGraphSchemaAction_NewStateNode::SpawnNodeFromTemplate<UAnimStateConduitNode>(
					Graph, NewObject<UAnimStateConduitNode>(GetTransientPackage(), NAME_None, RF_Transactional), AnimPosition(Args), false))
				: static_cast<UAnimStateNodeBase*>(FEdGraphSchemaAction_NewStateNode::SpawnNodeFromTemplate<UAnimStateNode>(
					Graph, NewObject<UAnimStateNode>(GetTransientPackage(), NAME_None, RF_Transactional), AnimPosition(Args), false));
			if (!NewState)
			{
				return MakeErrorObject(TEXT("Could not create state node."));
			}
			PlaceAnimNode(NewState, AnimPosition(Args));
			if (UAnimStateNode* State = Cast<UAnimStateNode>(NewState))
			{
				const FString StateName = GetString(Args, TEXT("state_name"), GetString(Args, TEXT("name")));
				if (!StateName.IsEmpty() && State->BoundGraph)
				{
					FBlueprintEditorUtils::RenameGraph(State->BoundGraph, StateName);
				}
				State->StateType = GetString(Args, TEXT("state_type")).Equals(TEXT("blend_graph"), ESearchCase::IgnoreCase)
					? AST_BlendGraph : AST_SingleAnimation;
				const FString EntryId = GetString(Args, TEXT("entry_node_id"));
				UAnimStateEntryNode* Entry = EntryId.IsEmpty() ? StateMachine->EditorStateMachineGraph->EntryNode
					: Cast<UAnimStateEntryNode>(FindNode(AnimBlueprint, EntryId));
				if (Entry && Entry->Pins.Num() > 0 && GetBool(Args, TEXT("connect_entry"), true))
				{
					ConnectPins(Entry->Pins[0], State->GetInputPin(), Error);
					Error.Empty();
				}
			}
			FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(AnimBlueprint);
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetStringField(TEXT("node_id"), NodeId(NewState));
			Result->SetStringField(TEXT("state_name"), NewState->GetStateName());
			Result->SetStringField(TEXT("graph"), NewState->GetBoundGraph() ? NewState->GetBoundGraph()->GetName() : FString());
			return Result;
		}

		if (Operation == TEXT("add_transition"))
		{
			UAnimBlueprint* AnimBlueprint = LoadAnimBlueprint(Args, Error);
			if (!AnimBlueprint)
			{
				return MakeErrorObject(Error);
			}
			UAnimStateNode* FromState = FindState(AnimBlueprint, GetString(Args, TEXT("from_state_node_id")), Error);
			UAnimStateNode* ToState = FindState(AnimBlueprint, GetString(Args, TEXT("to_state_node_id")), Error);
			if (!FromState || !ToState)
			{
				return MakeErrorObject(Error);
			}
			AnimBlueprint->Modify();
			FromState->GetGraph()->Modify();
			UAnimStateTransitionNode* Transition = FEdGraphSchemaAction_NewStateNode::SpawnNodeFromTemplate<UAnimStateTransitionNode>(
				FromState->GetGraph(),
				NewObject<UAnimStateTransitionNode>(GetTransientPackage(), NAME_None, RF_Transactional),
				AnimPosition(Args),
				false);
			if (!Transition)
			{
				return MakeErrorObject(TEXT("Could not create transition node."));
			}
			Transition->CreateConnections(FromState, ToState);
			PlaceAnimNode(Transition, AnimPosition(Args));
			Transition->PriorityOrder = static_cast<int32>(GetNumber(Args, TEXT("priority"), 0.0));
			Transition->CrossfadeDuration = static_cast<float>(GetNumber(Args, TEXT("crossfade"), 0.2));
			Transition->Bidirectional = GetBool(Args, TEXT("bidirectional"), false);
			Transition->bAutomaticRuleBasedOnSequencePlayerInState = GetBool(Args, TEXT("automatic_rule"), false);
			FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(AnimBlueprint);
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetStringField(TEXT("node_id"), NodeId(Transition));
			Result->SetStringField(TEXT("graph"), Transition->BoundGraph ? Transition->BoundGraph->GetName() : FString());
			return Result;
		}

		if (Operation == TEXT("set_transition"))
		{
			UAnimBlueprint* AnimBlueprint = LoadAnimBlueprint(Args, Error);
			if (!AnimBlueprint)
			{
				return MakeErrorObject(Error);
			}
			UAnimStateTransitionNode* Transition = FindTransition(AnimBlueprint, GetString(Args, TEXT("node_id")), Error);
			if (!Transition)
			{
				return MakeErrorObject(Error);
			}
			AnimBlueprint->Modify();
			Transition->Modify();
			if (Args.HasField(TEXT("priority"))) Transition->PriorityOrder = static_cast<int32>(GetNumber(Args, TEXT("priority")));
			if (Args.HasField(TEXT("crossfade"))) Transition->CrossfadeDuration = static_cast<float>(GetNumber(Args, TEXT("crossfade")));
			if (Args.HasField(TEXT("bidirectional"))) Transition->Bidirectional = GetBool(Args, TEXT("bidirectional"));
			if (Args.HasField(TEXT("automatic_rule"))) Transition->bAutomaticRuleBasedOnSequencePlayerInState = GetBool(Args, TEXT("automatic_rule"));
			const FString BlendMode = GetString(Args, TEXT("blend_mode"));
			if (!BlendMode.IsEmpty() && !ParseBlendMode(BlendMode, Transition->BlendMode))
			{
				return MakeErrorObject(FString::Printf(TEXT("Unknown blend mode: %s"), *BlendMode));
			}
			const FString CurvePath = GetString(Args, TEXT("custom_blend_curve"));
			if (!CurvePath.IsEmpty())
			{
				Transition->CustomBlendCurve = Cast<UCurveFloat>(LoadAsset(CurvePath, UCurveFloat::StaticClass(), Error));
				if (!Transition->CustomBlendCurve)
				{
					return MakeErrorObject(Error);
				}
			}
			const FString ProfilePath = GetString(Args, TEXT("blend_profile"));
			if (!ProfilePath.IsEmpty())
			{
				Transition->BlendProfile = Cast<UBlendProfile>(LoadAsset(ProfilePath, UBlendProfile::StaticClass(), Error));
				if (!Transition->BlendProfile)
				{
					return MakeErrorObject(Error);
				}
			}
			FBlueprintEditorUtils::MarkBlueprintAsModified(AnimBlueprint);
			return MakeSuccess();
		}

		if (Operation == TEXT("set_state_properties"))
		{
			UAnimBlueprint* AnimBlueprint = LoadAnimBlueprint(Args, Error);
			if (!AnimBlueprint)
			{
				return MakeErrorObject(Error);
			}
			UAnimStateNode* State = FindState(AnimBlueprint, GetString(Args, TEXT("node_id")), Error);
			if (!State)
			{
				return MakeErrorObject(Error);
			}
			AnimBlueprint->Modify();
			State->Modify();
			if (Args.HasField(TEXT("always_reset_on_entry"))) State->bAlwaysResetOnEntry = GetBool(Args, TEXT("always_reset_on_entry"));
			FBlueprintEditorUtils::MarkBlueprintAsModified(AnimBlueprint);
			return MakeSuccess();
		}

		if (Operation == TEXT("rename_state"))
		{
			UAnimBlueprint* AnimBlueprint = LoadAnimBlueprint(Args, Error);
			if (!AnimBlueprint)
			{
				return MakeErrorObject(Error);
			}
			UAnimStateNode* State = FindState(AnimBlueprint, GetString(Args, TEXT("node_id")), Error);
			const FString NewName = GetString(Args, TEXT("state_name"), GetString(Args, TEXT("name")));
			if (State && State->BoundGraph) { AnimBlueprint->Modify(); State->BoundGraph->Modify(); }
			if (!State || !State->BoundGraph || NewName.IsEmpty())
			{
				return MakeErrorObject(Error.IsEmpty() ? TEXT("state_name is required.") : Error);
			}
			FBlueprintEditorUtils::RenameGraph(State->BoundGraph, NewName);
			FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(AnimBlueprint);
			return MakeSuccess();
		}

		if (Operation == TEXT("remove_state") || Operation == TEXT("remove_transition"))
		{
			UAnimBlueprint* AnimBlueprint = LoadAnimBlueprint(Args, Error);
			if (!AnimBlueprint)
			{
				return MakeErrorObject(Error);
			}
			UEdGraphNode* Node = FindNode(AnimBlueprint, GetString(Args, TEXT("node_id")));
			if (!Node)
			{
				return MakeErrorObject(TEXT("Node not found."));
			}
			AnimBlueprint->Modify();
			FBlueprintEditorUtils::RemoveNode(AnimBlueprint, Node, true);
			FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(AnimBlueprint);
			return MakeSuccess();
		}

		if (Operation == TEXT("add_rule_node"))
		{
			UAnimBlueprint* AnimBlueprint = LoadAnimBlueprint(Args, Error);
			if (!AnimBlueprint)
			{
				return MakeErrorObject(Error);
			}
			UAnimStateTransitionNode* Transition = FindTransition(AnimBlueprint, GetString(Args, TEXT("transition_node_id")), Error);
			if (!Transition || !Transition->BoundGraph)
			{
				return MakeErrorObject(Error.IsEmpty() ? TEXT("Transition graph is unavailable.") : Error);
			}
			AnimBlueprint->Modify();
			Transition->BoundGraph->Modify();
			UEdGraphNode* Node = AddRuleNode(AnimBlueprint, Transition->BoundGraph, Args, Error);
			if (!Node)
			{
				return MakeErrorObject(Error);
			}
			FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(AnimBlueprint);
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetObjectField(TEXT("node"), SerializeNode(Node, Transition->BoundGraph));
			return Result;
		}

		return MakeErrorObject(FString::Printf(TEXT("Unknown animation graph operation: %s"), *Operation));
	}

	FJsonObjectPtr HandleAnimationGraphOperation(const FString& Operation, const FJsonObject& Args)
	{
		FJsonObjectPtr Result = HandleAnimationGraphOperationInternal(Operation, Args);
		bool bSuccess = false;
		if (!Result.IsValid() || !Result->TryGetBoolField(TEXT("success"), bSuccess) || !bSuccess)
		{
			return Result;
		}
		static const TSet<FString> Mutations = {
			TEXT("add_graph_node"), TEXT("set_node_property"), TEXT("connect_nodes"), TEXT("disconnect_nodes"),
			TEXT("delete_node"), TEXT("add_state_machine"), TEXT("add_state"), TEXT("add_conduit"),
			TEXT("add_transition"), TEXT("set_transition"), TEXT("set_state_properties"), TEXT("rename_state"),
			TEXT("remove_state"), TEXT("remove_transition"), TEXT("add_rule_node")
		};
		if (!Mutations.Contains(Operation))
		{
			return Result;
		}
		FString Error;
		UAnimBlueprint* AnimBlueprint = LoadAnimBlueprint(Args, Error);
		return AnimBlueprint ? FinalizeAssetEdit(AnimBlueprint, Args, Result) : Result;
	}
}
