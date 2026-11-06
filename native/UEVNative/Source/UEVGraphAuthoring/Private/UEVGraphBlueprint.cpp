#include "UEVGraphShared.h"

#include "Components/PrimitiveComponent.h"
#include "Components/SceneComponent.h"
#include "Components/StaticMeshComponent.h"
#include "EdGraphNode_Comment.h"
#include "Engine/StaticMesh.h"
#include "EdGraphSchema_K2.h"
#include "Engine/SCS_Node.h"
#include "Engine/SimpleConstructionScript.h"
#include "WidgetBlueprint.h"
#include "Blueprint/WidgetTree.h"
#include "K2Node_CallFunction.h"
#include "K2Node_CallFunctionOnMember.h"
#include "K2Node_CustomEvent.h"
#include "K2Node_Event.h"
#include "K2Node_ExecutionSequence.h"
#include "K2Node_IfThenElse.h"
#include "K2Node_InputAction.h"
#include "K2Node_MacroInstance.h"
#include "K2Node_Self.h"
#include "K2Node_VariableGet.h"
#include "K2Node_VariableSet.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/CompilerResultsLog.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Editor.h"
#include "ScopedTransaction.h"
#include "UObject/ReflectedTypeAccessors.h"

namespace UEVGraph
{
	namespace
	{
		FVector2D NodePosition(const FJsonObject& Args)
		{
			const TArray<TSharedPtr<FJsonValue>>* Position = GetArray(Args, TEXT("node_position"));
			if (Position && Position->Num() >= 2)
			{
				return FVector2D((*Position)[0]->AsNumber(), (*Position)[1]->AsNumber());
			}
			return FVector2D(GetNumber(Args, TEXT("x"), 0.0), GetNumber(Args, TEXT("y"), 0.0));
		}

		void PlaceNode(UEdGraphNode* Node, const FVector2D& Position)
		{
			if (Node)
			{
				Node->NodePosX = static_cast<int32>(Position.X);
				Node->NodePosY = static_cast<int32>(Position.Y);
			}
		}

		template <typename NodeType>
		NodeType* CreateTypedNode(UEdGraph* Graph, const FVector2D& Position, TFunctionRef<void(NodeType*)> Configure, FString& OutError)
		{
			FGraphNodeCreator<NodeType> Creator(*Graph);
			NodeType* Node = Creator.CreateNode(false);
			if (!Node)
			{
				OutError = TEXT("Failed to create graph node.");
				return nullptr;
			}
			Configure(Node);
			PlaceNode(Node, Position);
			Creator.Finalize();
			return Node;
		}

		UEdGraphNode* CreateRawNode(UEdGraph* Graph, UClass* NodeClass, const FVector2D& Position, FString& OutError)
		{
			if (!Graph || !NodeClass || !NodeClass->IsChildOf(UEdGraphNode::StaticClass()))
			{
				OutError = TEXT("A valid graph node class is required.");
				return nullptr;
			}
			UEdGraphNode* Node = NewObject<UEdGraphNode>(Graph, NodeClass, NAME_None, RF_Transactional);
			if (!Node)
			{
				OutError = TEXT("Failed to create graph node.");
				return nullptr;
			}
			Graph->AddNode(Node, false, false);
			Node->CreateNewGuid();
			Node->PostPlacedNewNode();
			if (Node->Pins.Num() == 0)
			{
				Node->AllocateDefaultPins();
			}
			PlaceNode(Node, Position);
			Node->ReconstructNode();
			return Node;
		}

		bool ApplyPinDefaults(UEdGraphNode* Node, const FJsonObject& Args, FString& OutError)
		{
			const TSharedPtr<FJsonObject> Params = GetObject(Args, TEXT("params"));
			if (!Params.IsValid())
			{
				return true;
			}
			for (const auto& Pair : Params->Values)
			{
				UEdGraphPin* Pin = FindPin(Node, Pair.Key);
				if (!Pin)
				{
					continue;
				}
				if (!SetPinDefault(Pin, Pair.Value, OutError))
				{
					return false;
				}
			}
			return true;
		}

		UEdGraphNode* AddBlueprintNode(UBlueprint* Blueprint, UEdGraph* Graph, const FJsonObject& Args, FString& OutError)
		{
			const FString NodeType = GetString(Args, TEXT("node_type"), GetString(Args, TEXT("node_kind"))).ToLower();
			const FVector2D Position = NodePosition(Args);
			if (!Graph)
			{
				OutError = TEXT("Blueprint graph is required.");
				return nullptr;
			}
			if (NodeType == TEXT("event") || NodeType == TEXT("event_node"))
			{
				const FString EventName = GetString(Args, TEXT("event_name"));
				if (EventName.IsEmpty())
				{
					OutError = TEXT("event_name is required for event nodes.");
					return nullptr;
				}
				int32 PosY = static_cast<int32>(Position.Y);
				UK2Node_Event* EventNode = FKismetEditorUtilities::AddDefaultEventNode(
					Blueprint,
					Graph,
					FName(*EventName),
					Blueprint->ParentClass,
					PosY);
				if (!EventNode)
				{
					OutError = FString::Printf(TEXT("Could not add event node: %s"), *EventName);
					return nullptr;
				}
				PlaceNode(EventNode, Position);
				return EventNode;
			}
			if (NodeType == TEXT("custom_event"))
			{
				const FString EventName = GetString(Args, TEXT("event_name"), GetString(Args, TEXT("name")));
				return CreateTypedNode<UK2Node_CustomEvent>(Graph, Position, [&](UK2Node_CustomEvent* Node)
				{
					Node->CustomFunctionName = FName(*EventName);
				}, OutError);
			}
			if (NodeType == TEXT("input_action"))
			{
				const FString ActionName = GetString(Args, TEXT("action_name"));
				return CreateTypedNode<UK2Node_InputAction>(Graph, Position, [&](UK2Node_InputAction* Node)
				{
					Node->InputActionName = FName(*ActionName);
				}, OutError);
			}
			if (NodeType == TEXT("function"))
			{
				const FString FunctionName = GetString(Args, TEXT("function_name"));
				const FString Target = GetString(Args, TEXT("target"), TEXT("self"));
				UClass* OwnerClass = ResolveFunctionOwner(Blueprint, Target, OutError);
				if (!OwnerClass)
				{
					return nullptr;
				}
				UFunction* Function = FindFunction(OwnerClass, FunctionName);
				const bool bSelfTarget = Target.IsEmpty() || Target.Equals(TEXT("self"), ESearchCase::IgnoreCase);
				if (!Function && bSelfTarget && Blueprint->GeneratedClass && Blueprint->GeneratedClass != OwnerClass)
				{
					// Blueprint-local functions live on the generated class, not on the parent class.
					if (UFunction* SelfFunction = FindFunction(Blueprint->GeneratedClass, FunctionName))
					{
						OwnerClass = Blueprint->GeneratedClass;
						Function = SelfFunction;
					}
				}
				if (!Function)
				{
					OutError = FString::Printf(TEXT("Function not found on %s: %s"), *OwnerClass->GetName(), *FunctionName);
					return nullptr;
				}
				const bool bComponentTarget = Target.StartsWith(TEXT("component:"), ESearchCase::IgnoreCase);
				UEdGraphNode* Node = nullptr;
				if (bComponentTarget)
				{
					Node = CreateTypedNode<UK2Node_CallFunctionOnMember>(Graph, Position, [&](UK2Node_CallFunctionOnMember* CallNode)
					{
						CallNode->FunctionReference.SetExternalMember(Function->GetFName(), OwnerClass);
						CallNode->SetFromFunction(Function);
						CallNode->MemberVariableToCallOn.SetSelfMember(FName(*Target.RightChop(10)));
					}, OutError);
				}
				else
				{
					Node = CreateTypedNode<UK2Node_CallFunction>(Graph, Position, [&](UK2Node_CallFunction* CallNode)
					{
						CallNode->SetFromFunction(Function);
						if (Target.StartsWith(TEXT("class:"), ESearchCase::IgnoreCase))
						{
							CallNode->FunctionReference.SetExternalMember(Function->GetFName(), OwnerClass);
						}
					}, OutError);
				}
				if (Node)
				{
					ApplyPinDefaults(Node, Args, OutError);
				}
				return Node;
			}
			if (NodeType == TEXT("variable_get") || NodeType == TEXT("variable_set") || NodeType == TEXT("component_reference"))
			{
				const FString VariableName = GetString(Args, TEXT("variable_name"), GetString(Args, TEXT("component_name")));
				if (VariableName.IsEmpty())
				{
					OutError = TEXT("variable_name is required.");
					return nullptr;
				}
				if (NodeType == TEXT("variable_set"))
				{
					return CreateTypedNode<UK2Node_VariableSet>(Graph, Position, [&](UK2Node_VariableSet* Node)
					{
						Node->VariableReference.SetSelfMember(FName(*VariableName));
					}, OutError);
				}
				return CreateTypedNode<UK2Node_VariableGet>(Graph, Position, [&](UK2Node_VariableGet* Node)
				{
					Node->VariableReference.SetSelfMember(FName(*VariableName));
				}, OutError);
			}
			if (NodeType == TEXT("self") || NodeType == TEXT("self_reference"))
			{
				return CreateTypedNode<UK2Node_Self>(Graph, Position, [](UK2Node_Self*) {}, OutError);
			}
			if (NodeType == TEXT("branch"))
			{
				return CreateTypedNode<UK2Node_IfThenElse>(Graph, Position, [](UK2Node_IfThenElse*) {}, OutError);
			}
			if (NodeType == TEXT("sequence"))
			{
				return CreateTypedNode<UK2Node_ExecutionSequence>(Graph, Position, [](UK2Node_ExecutionSequence*) {}, OutError);
			}
			if (NodeType == TEXT("macro"))
			{
				FString MacroName = GetString(Args, TEXT("macro_name"), GetString(Args, TEXT("name")));
				FString MacroLibrary = GetString(Args, TEXT("macro_library"), GetString(Args, TEXT("macro_path")));
				if (MacroName.IsEmpty() && MacroLibrary.Contains(TEXT(":")))
				{
					FString LibraryPart;
					FString NamePart;
					if (MacroLibrary.Split(TEXT(":"), &LibraryPart, &NamePart))
					{
						MacroLibrary = LibraryPart;
						MacroName = NamePart;
					}
				}
				if (MacroName.IsEmpty())
				{
					OutError = TEXT("macro_name is required for macro nodes.");
					return nullptr;
				}
				UEdGraph* MacroGraph = nullptr;
				if (!MacroLibrary.IsEmpty())
				{
					TSharedPtr<FJsonObject> LibraryArgs = MakeShared<FJsonObject>();
					for (const TPair<FString, TSharedPtr<FJsonValue>>& Pair : Args.Values)
					{
						LibraryArgs->Values.Add(Pair.Key, Pair.Value);
					}
					LibraryArgs->SetStringField(TEXT("asset_path"), MacroLibrary);
					LibraryArgs->SetStringField(TEXT("blueprint_name"), MacroLibrary);
					FString LibraryError;
					UBlueprint* Library = LoadBlueprint(*LibraryArgs, LibraryError);
					if (!Library)
					{
						OutError = LibraryError;
						return nullptr;
					}
					MacroGraph = FindGraphByName(Library, MacroName);
					if (!MacroGraph)
					{
						OutError = FString::Printf(TEXT("Macro not found in %s: %s"), *MacroLibrary, *MacroName);
						return nullptr;
					}
				}
				else
				{
					UBlueprint* StandardMacros = LoadObject<UBlueprint>(nullptr, TEXT("/Engine/EditorBlueprintResources/StandardMacros.StandardMacros"));
					if (!StandardMacros)
					{
						StandardMacros = LoadObject<UBlueprint>(nullptr, TEXT("/Engine/EditorBlueprintResources/StandardMacros"));
					}
					MacroGraph = StandardMacros ? FindGraphByName(StandardMacros, MacroName) : nullptr;
					if (!MacroGraph)
					{
						OutError = FString::Printf(TEXT("Standard macro not found: %s"), *MacroName);
						return nullptr;
					}
				}
				return CreateTypedNode<UK2Node_MacroInstance>(Graph, Position, [&](UK2Node_MacroInstance* Node)
				{
					Node->SetMacroGraph(MacroGraph);
				}, OutError);
			}
			if (NodeType == TEXT("comment"))
			{
				UEdGraphNode_Comment* Comment = NewObject<UEdGraphNode_Comment>(Graph, NAME_None, RF_Transactional);
				Graph->AddNode(Comment, false, false);
				Comment->CreateNewGuid();
				Comment->NodeComment = GetString(Args, TEXT("comment"), TEXT("Comment"));
				Comment->NodeWidth = static_cast<int32>(GetNumber(Args, TEXT("width"), 400.0));
				Comment->NodeHeight = static_cast<int32>(GetNumber(Args, TEXT("height"), 160.0));
				PlaceNode(Comment, Position);
				return Comment;
			}
			if (NodeType == TEXT("raw"))
			{
				const FString ClassName = GetString(Args, TEXT("node_class"));
				UClass* NodeClass = ResolveClass(ClassName, UEdGraphNode::StaticClass(), OutError);
				return NodeClass ? CreateRawNode(Graph, NodeClass, Position, OutError) : nullptr;
			}

			OutError = FString::Printf(TEXT("Unsupported blueprint node type: %s"), *NodeType);
			return nullptr;
		}

		TArray<TSharedPtr<FJsonValue>> VectorArray(const FVector& Value)
		{
			TArray<TSharedPtr<FJsonValue>> Result;
			Result.Add(MakeShared<FJsonValueNumber>(Value.X));
			Result.Add(MakeShared<FJsonValueNumber>(Value.Y));
			Result.Add(MakeShared<FJsonValueNumber>(Value.Z));
			return Result;
		}

		FJsonObjectPtr BuildComponentSummary(USCS_Node* Node)
		{
			FJsonObjectPtr Entry = MakeObject();
			if (!Node)
			{
				return Entry;
			}
			UActorComponent* Template = Node->ComponentTemplate;
			Entry->SetStringField(TEXT("name"), Node->GetVariableName().ToString());
			Entry->SetStringField(TEXT("node_name"), Node->GetName());
			Entry->SetStringField(TEXT("class"), Template ? Template->GetClass()->GetName() : FString());
			if (!Node->ParentComponentOrVariableName.IsNone())
			{
				Entry->SetStringField(TEXT("parent"), Node->ParentComponentOrVariableName.ToString());
			}
			if (const USceneComponent* SceneComponent = Cast<USceneComponent>(Template))
			{
				Entry->SetArrayField(TEXT("relative_location"), VectorArray(SceneComponent->GetRelativeLocation()));
				const FRotator Rotation = SceneComponent->GetRelativeRotation();
				TArray<TSharedPtr<FJsonValue>> RotationArray;
				RotationArray.Add(MakeShared<FJsonValueNumber>(Rotation.Pitch));
				RotationArray.Add(MakeShared<FJsonValueNumber>(Rotation.Yaw));
				RotationArray.Add(MakeShared<FJsonValueNumber>(Rotation.Roll));
				Entry->SetArrayField(TEXT("relative_rotation"), RotationArray);
				Entry->SetArrayField(TEXT("relative_scale"), VectorArray(SceneComponent->GetRelativeScale3D()));
			}
			if (const UStaticMeshComponent* MeshComponent = Cast<UStaticMeshComponent>(Template))
			{
				const UStaticMesh* Mesh = MeshComponent->GetStaticMesh();
				Entry->SetStringField(TEXT("static_mesh"), Mesh ? Mesh->GetPathName() : FString());
			}
			if (const UPrimitiveComponent* PrimitiveComponent = Cast<UPrimitiveComponent>(Template))
			{
				Entry->SetBoolField(TEXT("simulate_physics"), PrimitiveComponent->BodyInstance.bSimulatePhysics);
				Entry->SetBoolField(TEXT("gravity_enabled"), PrimitiveComponent->BodyInstance.bEnableGravity);
				Entry->SetBoolField(TEXT("override_mass"), PrimitiveComponent->BodyInstance.bOverrideMass);
				const float MassOverride = PrimitiveComponent->BodyInstance.GetMassOverride();
				Entry->SetNumberField(TEXT("mass"), PrimitiveComponent->BodyInstance.bOverrideMass && MassOverride > 0.0f
					? MassOverride
					: PrimitiveComponent->GetMass());
				Entry->SetNumberField(TEXT("mass_override_kg"), MassOverride);
			}
			return Entry;
		}

		USCS_Node* RequireComponentNode(UBlueprint* Blueprint, const FJsonObject& Args, FString& OutError)
		{
			const FString ComponentName = GetString(Args, TEXT("component_name"), GetString(Args, TEXT("name")));
			if (ComponentName.IsEmpty())
			{
				OutError = TEXT("component_name is required.");
				return nullptr;
			}
			USCS_Node* Node = FindComponentNode(Blueprint, ComponentName);
			if (!Node || !Node->ComponentTemplate)
			{
				FString Available;
				if (Blueprint && Blueprint->SimpleConstructionScript)
				{
					for (USCS_Node* Candidate : Blueprint->SimpleConstructionScript->GetAllNodes())
					{
						if (Candidate)
						{
							Available += (Available.IsEmpty() ? TEXT("") : TEXT(", ")) + Candidate->GetVariableName().ToString();
						}
					}
				}
				OutError = FString::Printf(
					TEXT("Blueprint component not found: %s. Available components: %s"),
					*ComponentName,
					Available.IsEmpty() ? TEXT("(none)") : *Available);
				return nullptr;
			}
			return Node;
		}
	}

		FJsonObjectPtr HandleBlueprintOperationInternal(const FString& Operation, const FJsonObject& Args)
	{
		FString Error;
		if (FJsonObjectPtr DepthResult = HandleBlueprintDepthOperation(Operation, Args))
		{
			return DepthResult;
		}
		if (Operation == TEXT("add_component"))
		{
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint || !Blueprint->SimpleConstructionScript)
			{
				return MakeErrorObject(Error.IsEmpty() ? TEXT("Blueprint construction script is unavailable.") : Error);
			}
			Blueprint->Modify();
			Blueprint->SimpleConstructionScript->Modify();
			const FString ComponentName = GetString(Args, TEXT("component_name"), GetString(Args, TEXT("name")));
			const FString ComponentType = GetString(Args, TEXT("component_type"), GetString(Args, TEXT("class_name")));
			if (ComponentName.IsEmpty() || ComponentType.IsEmpty())
			{
				return MakeErrorObject(TEXT("component_name and component_type are required."));
			}
			UClass* ComponentClass = ResolveClass(ComponentType, UActorComponent::StaticClass(), Error);
			if (!ComponentClass)
			{
				return MakeErrorObject(Error);
			}
			USCS_Node* Node = FindComponentNode(Blueprint, ComponentName);
			if (!Node)
			{
				Node = Blueprint->SimpleConstructionScript->CreateNode(ComponentClass, FName(*ComponentName));
				if (!Node)
				{
					return MakeErrorObject(TEXT("Could not create component node."));
				}
				const FString ParentName = GetString(Args, TEXT("parent_component_name"));
				if (!ParentName.IsEmpty())
				{
					if (ParentName.Equals(TEXT("none"), ESearchCase::IgnoreCase)
						|| ParentName.Equals(TEXT("root"), ESearchCase::IgnoreCase))
					{
						Blueprint->SimpleConstructionScript->AddNode(Node);
					}
					else if (USCS_Node* Parent = FindComponentNode(Blueprint, ParentName))
					{
						Parent->AddChildNode(Node);
					}
					else
					{
						FString Available;
						for (USCS_Node* Candidate : Blueprint->SimpleConstructionScript->GetAllNodes())
						{
							if (Candidate)
							{
								Available += (Available.IsEmpty() ? TEXT("") : TEXT(", ")) + Candidate->GetVariableName().ToString();
							}
						}
						Error = FString::Printf(
							TEXT("Parent component not found: %s. Available components: %s. Pass parent_component_name \"none\" to add a root node."),
							*ParentName,
							Available.IsEmpty() ? TEXT("(none)") : *Available);
						return MakeErrorObject(Error);
					}
				}
				else if (USCS_Node* DefaultRoot = Blueprint->SimpleConstructionScript->GetDefaultSceneRootNode())
				{
					if (DefaultRoot != Node)
					{
						DefaultRoot->AddChildNode(Node);
					}
				}
				else
				{
					Blueprint->SimpleConstructionScript->AddNode(Node);
				}
			}
			if (USceneComponent* SceneComponent = Cast<USceneComponent>(Node->ComponentTemplate))
			{
				const TArray<TSharedPtr<FJsonValue>>* Location = GetArray(Args, TEXT("location"));
				if (Location && Location->Num() >= 3)
				{
					SceneComponent->SetRelativeLocation(FVector((*Location)[0]->AsNumber(), (*Location)[1]->AsNumber(), (*Location)[2]->AsNumber()));
				}
				const TArray<TSharedPtr<FJsonValue>>* Rotation = GetArray(Args, TEXT("rotation"));
				if (Rotation && Rotation->Num() >= 3)
				{
					SceneComponent->SetRelativeRotation(FRotator((*Rotation)[0]->AsNumber(), (*Rotation)[1]->AsNumber(), (*Rotation)[2]->AsNumber()));
				}
				const TArray<TSharedPtr<FJsonValue>>* Scale = GetArray(Args, TEXT("scale"));
				if (Scale && Scale->Num() >= 3)
				{
					SceneComponent->SetRelativeScale3D(FVector((*Scale)[0]->AsNumber(), (*Scale)[1]->AsNumber(), (*Scale)[2]->AsNumber()));
				}
			}
			const TSharedPtr<FJsonObject> Properties = GetObject(Args, TEXT("component_properties"));
			if (Properties.IsValid())
			{
				for (const auto& Pair : Properties->Values)
				{
					if (!SetObjectPropertyPath(Node->ComponentTemplate, Pair.Key, Pair.Value, Error))
					{
						return MakeErrorObject(Error);
					}
				}
			}
			FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetStringField(TEXT("component_name"), Node->GetVariableName().ToString());
			Result->SetStringField(TEXT("class"), Node->ComponentTemplate ? Node->ComponentTemplate->GetClass()->GetName() : FString());
			return Result;
		}
		if (Operation == TEXT("inspect_components"))
		{
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			FJsonObjectPtr Result = MakeSuccess();
			TArray<TSharedPtr<FJsonValue>> Components;
			if (Blueprint->SimpleConstructionScript)
			{
				for (USCS_Node* Node : Blueprint->SimpleConstructionScript->GetAllNodes())
				{
					if (Node)
					{
						Components.Add(MakeShared<FJsonValueObject>(BuildComponentSummary(Node)));
					}
				}
			}
			Result->SetArrayField(TEXT("components"), Components);
			return Result;
		}
		if (Operation == TEXT("set_component_property"))
		{
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			USCS_Node* Node = RequireComponentNode(Blueprint, Args, Error);
			if (!Node)
			{
				return MakeErrorObject(Error);
			}
			const FString PropertyName = GetString(Args, TEXT("property_name"), GetString(Args, TEXT("property")));
			FJsonValuePtr Value = Args.TryGetField(TEXT("property_value"));
			if (!Value.IsValid())
			{
				Value = Args.TryGetField(TEXT("value"));
			}
			if (PropertyName.IsEmpty() || !Value.IsValid())
			{
				return MakeErrorObject(TEXT("property_name and property_value are required."));
			}
			Blueprint->Modify();
			Blueprint->SimpleConstructionScript->Modify();
			Node->ComponentTemplate->Modify();
			if (!SetObjectPropertyPath(Node->ComponentTemplate, PropertyName, Value, Error))
			{
				return MakeErrorObject(Error);
			}
			FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetStringField(TEXT("component_name"), Node->GetVariableName().ToString());
			Result->SetObjectField(TEXT("component"), BuildComponentSummary(Node));
			return Result;
		}

		if (Operation == TEXT("set_static_mesh"))
		{
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			USCS_Node* Node = RequireComponentNode(Blueprint, Args, Error);
			if (!Node)
			{
				return MakeErrorObject(Error);
			}
			UStaticMeshComponent* MeshComponent = Cast<UStaticMeshComponent>(Node->ComponentTemplate);
			if (!MeshComponent)
			{
				return MakeErrorObject(FString::Printf(
					TEXT("Component %s is a %s, not a StaticMeshComponent."),
					*Node->GetVariableName().ToString(),
					*Node->ComponentTemplate->GetClass()->GetName()));
			}
			const FString MeshPath = GetString(Args, TEXT("static_mesh"), GetString(Args, TEXT("mesh")));
			if (MeshPath.IsEmpty())
			{
				return MakeErrorObject(TEXT("static_mesh is required (for example /Engine/BasicShapes/Cube.Cube)."));
			}
			UStaticMesh* Mesh = MeshPath.Equals(TEXT("None"), ESearchCase::IgnoreCase)
				? nullptr
				: Cast<UStaticMesh>(LoadObject<UObject>(nullptr, *MeshPath));
			if (!Mesh && !MeshPath.Equals(TEXT("None"), ESearchCase::IgnoreCase))
			{
				return MakeErrorObject(FString::Printf(TEXT("Could not load static mesh: %s"), *MeshPath));
			}
			Blueprint->Modify();
			Blueprint->SimpleConstructionScript->Modify();
			MeshComponent->Modify();
			MeshComponent->SetStaticMesh(Mesh);
			FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetStringField(TEXT("component_name"), Node->GetVariableName().ToString());
			Result->SetStringField(TEXT("static_mesh"), Mesh ? Mesh->GetPathName() : FString());
			Result->SetObjectField(TEXT("component"), BuildComponentSummary(Node));
			return Result;
		}

		if (Operation == TEXT("set_physics_properties"))
		{
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			USCS_Node* Node = RequireComponentNode(Blueprint, Args, Error);
			if (!Node)
			{
				return MakeErrorObject(Error);
			}
			UPrimitiveComponent* PrimitiveComponent = Cast<UPrimitiveComponent>(Node->ComponentTemplate);
			if (!PrimitiveComponent)
			{
				return MakeErrorObject(FString::Printf(
					TEXT("Component %s is a %s, not a PrimitiveComponent with physics support."),
					*Node->GetVariableName().ToString(),
					*Node->ComponentTemplate->GetClass()->GetName()));
			}
			Blueprint->Modify();
			Blueprint->SimpleConstructionScript->Modify();
			PrimitiveComponent->Modify();
			if (Args.HasField(TEXT("simulate_physics")))
			{
				PrimitiveComponent->SetSimulatePhysics(GetBool(Args, TEXT("simulate_physics"), true));
			}
			if (Args.HasField(TEXT("gravity_enabled")))
			{
				PrimitiveComponent->SetEnableGravity(GetBool(Args, TEXT("gravity_enabled"), true));
			}
			if (Args.HasField(TEXT("mass")))
			{
				const float Mass = static_cast<float>(GetNumber(Args, TEXT("mass"), 1.0));
				if (Mass <= 0.0f)
				{
					return MakeErrorObject(TEXT("mass must be greater than zero."));
				}
				PrimitiveComponent->SetMassOverrideInKg(NAME_None, Mass, true);
			}
			if (Args.HasField(TEXT("linear_damping")))
			{
				PrimitiveComponent->SetLinearDamping(static_cast<float>(GetNumber(Args, TEXT("linear_damping"), 0.01)));
			}
			if (Args.HasField(TEXT("angular_damping")))
			{
				PrimitiveComponent->SetAngularDamping(static_cast<float>(GetNumber(Args, TEXT("angular_damping"), 0.0)));
			}
			FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetStringField(TEXT("component_name"), Node->GetVariableName().ToString());
			Result->SetObjectField(TEXT("component"), BuildComponentSummary(Node));
			return Result;
		}

		if (Operation == TEXT("set_collision_profile"))
		{
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			USCS_Node* Node = RequireComponentNode(Blueprint, Args, Error);
			if (!Node)
			{
				return MakeErrorObject(Error);
			}
			UPrimitiveComponent* PrimitiveComponent = Cast<UPrimitiveComponent>(Node->ComponentTemplate);
			if (!PrimitiveComponent)
			{
				return MakeErrorObject(TEXT("Component is not a PrimitiveComponent."));
			}
			const FString ProfileName = GetString(Args, TEXT("profile_name"));
			if (ProfileName.IsEmpty())
			{
				return MakeErrorObject(TEXT("profile_name is required."));
			}
			const FString PreviousProfile = PrimitiveComponent->BodyInstance.GetCollisionProfileName().ToString();
			Blueprint->Modify();
			Blueprint->SimpleConstructionScript->Modify();
			PrimitiveComponent->Modify();
			PrimitiveComponent->SetCollisionProfileName(FName(*ProfileName));
			FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
			FCompilerResultsLog CompileResults;
			FKismetEditorUtilities::CompileBlueprint(Blueprint, EBlueprintCompileOptions::None, &CompileResults);
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetStringField(TEXT("component_name"), Node->GetVariableName().ToString());
			Result->SetObjectField(TEXT("component"), BuildComponentSummary(Node));
			FJsonObjectPtr Collision = MakeObject();
			Collision->SetStringField(TEXT("requested"), ProfileName);
			Collision->SetStringField(TEXT("previous"), PreviousProfile);
			Collision->SetStringField(TEXT("applied"), PrimitiveComponent->BodyInstance.GetCollisionProfileName().ToString());
			Collision->SetBoolField(TEXT("verified"), PrimitiveComponent->BodyInstance.GetCollisionProfileName().ToString().Equals(ProfileName, ESearchCase::IgnoreCase));
			Result->SetObjectField(TEXT("collision_profile"), Collision);
			Result->SetNumberField(TEXT("compile_errors"), CompileResults.NumErrors);
			Result->SetNumberField(TEXT("compile_warnings"), CompileResults.NumWarnings);
			return Result;
		}

		if (Operation == TEXT("set_collision_response"))
		{
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			USCS_Node* Node = RequireComponentNode(Blueprint, Args, Error);
			if (!Node)
			{
				return MakeErrorObject(Error);
			}
			UPrimitiveComponent* PrimitiveComponent = Cast<UPrimitiveComponent>(Node->ComponentTemplate);
			if (!PrimitiveComponent)
			{
				return MakeErrorObject(TEXT("Component is not a PrimitiveComponent."));
			}
			const int32 Channel = static_cast<int32>(GetNumber(Args, TEXT("channel"), -1.0));
			const int32 Response = static_cast<int32>(GetNumber(Args, TEXT("response"), -1.0));
			if (Channel < 0 || Channel >= ECC_MAX)
			{
				return MakeErrorObject(TEXT("channel must be a collision channel index (0-7)."));
			}
			if (Response < 0 || Response > ECR_MAX)
			{
				return MakeErrorObject(TEXT("response must be 0 (ignore), 1 (overlap), or 2 (block)."));
			}
			Blueprint->Modify();
			Blueprint->SimpleConstructionScript->Modify();
			PrimitiveComponent->Modify();
			PrimitiveComponent->SetCollisionProfileName(FName(TEXT("Custom")));
			PrimitiveComponent->SetCollisionResponseToChannel(static_cast<ECollisionChannel>(Channel), static_cast<ECollisionResponse>(Response));
			FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
			FCompilerResultsLog CompileResults;
			FKismetEditorUtilities::CompileBlueprint(Blueprint, EBlueprintCompileOptions::None, &CompileResults);
			const int32 Applied = static_cast<int32>(PrimitiveComponent->GetCollisionResponseToChannel(static_cast<ECollisionChannel>(Channel)));
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetStringField(TEXT("component_name"), Node->GetVariableName().ToString());
			Result->SetObjectField(TEXT("component"), BuildComponentSummary(Node));
			FJsonObjectPtr Collision = MakeObject();
			Collision->SetNumberField(TEXT("channel_index"), Channel);
			Collision->SetNumberField(TEXT("response_index"), Response);
			Collision->SetNumberField(TEXT("applied_response_index"), Applied);
			Collision->SetBoolField(TEXT("verified"), Applied == Response);
			Result->SetObjectField(TEXT("collision_response"), Collision);
			Result->SetNumberField(TEXT("compile_errors"), CompileResults.NumErrors);
			Result->SetNumberField(TEXT("compile_warnings"), CompileResults.NumWarnings);
			return Result;
		}

		if (Operation == TEXT("read") || Operation == TEXT("inspect_blueprint"))
		{
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetStringField(TEXT("name"), Blueprint->GetName());
			Result->SetStringField(TEXT("asset_path"), Blueprint->GetPathName());
			Result->SetStringField(TEXT("class"), Blueprint->GetClass()->GetName());
			Result->SetStringField(TEXT("parent_class"), Blueprint->ParentClass ? Blueprint->ParentClass->GetName() : FString());
			Result->SetStringField(TEXT("parent_class_path"), Blueprint->ParentClass ? Blueprint->ParentClass->GetPathName() : FString());
			Result->SetStringField(TEXT("generated_class"), Blueprint->GeneratedClass ? Blueprint->GeneratedClass->GetName() : FString());
			Result->SetBoolField(TEXT("is_actor_based"), FBlueprintEditorUtils::IsActorBased(Blueprint));

			TArray<TSharedPtr<FJsonValue>> Components;
			if (Blueprint->SimpleConstructionScript)
			{
				for (USCS_Node* Node : Blueprint->SimpleConstructionScript->GetAllNodes())
				{
					if (Node)
					{
						Components.Add(MakeShared<FJsonValueObject>(BuildComponentSummary(Node)));
					}
				}
			}
			Result->SetArrayField(TEXT("components"), Components);

			TArray<TSharedPtr<FJsonValue>> Variables;
			for (const FBPVariableDescription& Variable : Blueprint->NewVariables)
			{
				FJsonObjectPtr Entry = MakeObject();
				Entry->SetStringField(TEXT("name"), Variable.VarName.ToString());
				Entry->SetStringField(TEXT("type"), PinTypeName(Variable.VarType));
				Entry->SetStringField(TEXT("default_value"), Variable.DefaultValue);
				Entry->SetBoolField(TEXT("instance_editable"),
					(Variable.PropertyFlags & CPF_Edit) != 0 && (Variable.PropertyFlags & CPF_DisableEditOnInstance) == 0);
				bool bExposed = false;
				for (const FBPVariableMetaDataEntry& MetaData : Variable.MetaDataArray)
				{
					if (MetaData.DataKey == TEXT("ExposeOnSpawn"))
					{
						bExposed = MetaData.DataValue.Equals(TEXT("true"), ESearchCase::IgnoreCase);
						break;
					}
				}
				Entry->SetBoolField(TEXT("exposed"), bExposed);
				Variables.Add(MakeShared<FJsonValueObject>(Entry));
			}
			Result->SetArrayField(TEXT("variables"), Variables);

			TArray<TSharedPtr<FJsonValue>> Functions;
			for (UEdGraph* FunctionGraph : Blueprint->FunctionGraphs)
			{
				if (FunctionGraph)
				{
					Functions.Add(MakeShared<FJsonValueString>(FunctionGraph->GetName()));
				}
			}
			Result->SetArrayField(TEXT("functions"), Functions);

			TArray<UEdGraph*> Graphs;
			AppendGraphs(Blueprint, Graphs, true);
			const bool bIncludeNodes = GetBool(Args, TEXT("include_nodes"), false);
			TArray<TSharedPtr<FJsonValue>> GraphValues;
			for (UEdGraph* Graph : Graphs)
			{
				if (!Graph)
				{
					continue;
				}
				if (bIncludeNodes)
				{
					GraphValues.Add(MakeShared<FJsonValueObject>(SerializeGraph(Graph, true)));
					continue;
				}
				FJsonObjectPtr Entry = MakeObject();
				Entry->SetStringField(TEXT("name"), Graph->GetName());
				Entry->SetStringField(TEXT("class"), Graph->GetClass()->GetName());
				Entry->SetNumberField(TEXT("node_count"), Graph->Nodes.Num());
				GraphValues.Add(MakeShared<FJsonValueObject>(Entry));
			}
			Result->SetArrayField(TEXT("graphs"), GraphValues);
			return Result;
		}

		if (Operation == TEXT("inspect_graph"))
		{
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			const bool bIncludeNodes = GetBool(Args, TEXT("include_nodes"), true);
			bool bGraphNamed = false;
			UEdGraph* RequestedGraph = ResolveGraphArg(Blueprint, Args, bGraphNamed, Error);
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetStringField(TEXT("asset_path"), Blueprint->GetPathName());
			if (bGraphNamed && !RequestedGraph)
			{
				const FString Requested = GetString(Args, TEXT("graph_id"), GetString(Args, TEXT("graph_name")));
				return MakeGraphNotFoundError(Requested, Blueprint);
			}
			if (RequestedGraph)
			{
				Result->SetObjectField(TEXT("graph"), SerializeGraph(RequestedGraph, bIncludeNodes));
				Result->SetStringField(TEXT("graph_id"), GraphId(RequestedGraph));
				Result->SetStringField(TEXT("kind"), GraphKind(RequestedGraph));
				Result->SetStringField(TEXT("name"), RequestedGraph->GetName());
				return Result;
			}
			TArray<UEdGraph*> Graphs;
			AppendGraphs(Blueprint, Graphs, true);
			TArray<TSharedPtr<FJsonValue>> GraphValues;
			for (UEdGraph* Graph : Graphs)
			{
				GraphValues.Add(MakeShared<FJsonValueObject>(SerializeGraph(Graph, bIncludeNodes)));
			}
			Result->SetArrayField(TEXT("graphs"), GraphValues);
			return Result;
		}

		if (Operation == TEXT("add_node"))
		{
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			bool bGraphNamed = false;
			UEdGraph* Graph = ResolveGraphArg(Blueprint, Args, bGraphNamed, Error);
			if (!Graph)
			{
				if (bGraphNamed)
				{
					const FString Requested = GetString(Args, TEXT("graph_id"), GetString(Args, TEXT("graph_name")));
					return MakeGraphNotFoundError(Requested, Blueprint);
				}
				return MakeErrorObject(TEXT("graph_name or graph_id is required."));
			}
			Blueprint->Modify();
			Graph->Modify();
			UEdGraphNode* Node = AddBlueprintNode(Blueprint, Graph, Args, Error);
			if (!Node)
			{
				return MakeErrorObject(Error);
			}
			FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetObjectField(TEXT("node"), SerializeNode(Node, Graph));
			Result->SetStringField(TEXT("graph_id"), GraphId(Graph));
			return Result;
		}

		if (Operation == TEXT("connect_nodes") || Operation == TEXT("disconnect_nodes"))
		{
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			bool bGraphNamed = false;
			UEdGraph* ScopeGraph = ResolveOptionalGraph(Blueprint, Args, bGraphNamed, Error);
			if (bGraphNamed && !ScopeGraph)
			{
				return MakeErrorObject(Error);
			}
			const FString ScopeSuffix = bGraphNamed ? FString::Printf(TEXT(" in graph '%s'"), *ScopeGraph->GetName()) : FString();

			const FString SourceNodeId = GetString(Args, TEXT("source_node_id"));
			const FString TargetNodeId = GetString(Args, TEXT("target_node_id"));
			const FString SourcePinName = GetString(Args, TEXT("source_pin"));
			const FString TargetPinName = GetString(Args, TEXT("target_pin"));

			UEdGraph* SourceGraph = nullptr;
			UEdGraph* TargetGraph = nullptr;
			UEdGraphNode* SourceNode = nullptr;
			UEdGraphNode* TargetNode = nullptr;
			if (bGraphNamed)
			{
				SourceNode = FindNodeInGraph(ScopeGraph, SourceNodeId);
				TargetNode = FindNodeInGraph(ScopeGraph, TargetNodeId);
			}
			else
			{
				SourceNode = FindNode(Blueprint, SourceNodeId, &SourceGraph);
				TargetNode = FindNode(Blueprint, TargetNodeId, &TargetGraph);
			}

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
			Blueprint->Modify();
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
				if (!Error.IsEmpty())
				{
					return MakeErrorObject(Error);
				}
			}
			FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetStringField(TEXT("source_node_id"), NodeId(SourceNode));
			Result->SetStringField(TEXT("target_node_id"), NodeId(TargetNode));
			if (UEdGraph* ResolvedGraph = bGraphNamed ? ScopeGraph : (SourceGraph ? SourceGraph : TargetGraph))
			{
				Result->SetStringField(TEXT("graph"), ResolvedGraph->GetName());
			}
			return Result;
		}

		if (Operation == TEXT("delete_node"))
		{
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			bool bGraphNamed = false;
			UEdGraph* ScopeGraph = ResolveOptionalGraph(Blueprint, Args, bGraphNamed, Error);
			if (bGraphNamed && !ScopeGraph)
			{
				return MakeErrorObject(Error);
			}
			const FString NodeIdValue = GetString(Args, TEXT("node_id"));
			UEdGraphNode* Node = bGraphNamed
				? FindNodeInGraph(ScopeGraph, NodeIdValue)
				: FindNode(Blueprint, NodeIdValue);
			if (!Node)
			{
				const FString ScopeSuffix = bGraphNamed ? FString::Printf(TEXT(" in graph '%s'"), *ScopeGraph->GetName()) : FString();
				return MakeErrorObject(FString::Printf(TEXT("Node '%s' not found%s. Use inspect_graph to list node ids."), *NodeIdValue, *ScopeSuffix));
			}
			UEdGraph* NodeGraph = Node->GetGraph();
			Blueprint->Modify();
			FBlueprintEditorUtils::RemoveNode(Blueprint, Node, true);
			FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
			FJsonObjectPtr Result = MakeSuccess();
			if (NodeGraph)
			{
				Result->SetStringField(TEXT("graph"), NodeGraph->GetName());
			}
			return Result;
		}

		if (Operation == TEXT("set_pin_default"))
		{
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			UEdGraphNode* Node = FindNode(Blueprint, GetString(Args, TEXT("node_id")));
			UEdGraphPin* Pin = FindPin(Node, GetString(Args, TEXT("pin")));
			if (!Pin)
			{
				return MakeErrorObject(TEXT("Pin not found."));
			}
			const TSharedPtr<FJsonValue> Value = Args.TryGetField(TEXT("value"));
			Blueprint->Modify();
			Node->Modify();
			if (!Value.IsValid() || !SetPinDefault(Pin, Value, Error))
			{
				return MakeErrorObject(Error.IsEmpty() ? TEXT("value is required.") : Error);
			}
			FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetObjectField(TEXT("node"), SerializeNode(Node, nullptr));
			return Result;
		}

		if (Operation == TEXT("add_variable"))
		{
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			Blueprint->Modify();
			const FString VariableName = GetString(Args, TEXT("variable_name"), GetString(Args, TEXT("name")));
			if (VariableName.IsEmpty())
			{
				return MakeErrorObject(TEXT("variable_name is required."));
			}
			FEdGraphPinType PinType;
			if (!PinTypeFromArgs(Args, TEXT("variable_type"), TEXT("bool"), PinType, Error))
			{
				return MakeErrorObject(Error);
			}
			const FString DefaultValue = GetString(Args, TEXT("default_value"));
			if (!FBlueprintEditorUtils::AddMemberVariable(Blueprint, FName(*VariableName), PinType, DefaultValue))
			{
				return MakeErrorObject(FString::Printf(TEXT("Could not add variable: %s"), *VariableName));
			}
			const FString Category = GetString(Args, TEXT("category"));
			const FString Tooltip = GetString(Args, TEXT("tooltip"));
			if (!Category.IsEmpty())
			{
				FBlueprintEditorUtils::SetBlueprintVariableMetaData(Blueprint, FName(*VariableName), nullptr, TEXT("Category"), Category);
			}
			if (!Tooltip.IsEmpty())
			{
				FBlueprintEditorUtils::SetBlueprintVariableMetaData(Blueprint, FName(*VariableName), nullptr, TEXT("ToolTip"), Tooltip);
			}
			const bool bInstanceEditable = GetBool(Args, TEXT("is_instance_editable"), false);
			const bool bExposed = GetBool(Args, TEXT("is_exposed"), false);
			for (FBPVariableDescription& Variable : Blueprint->NewVariables)
			{
				if (Variable.VarName == FName(*VariableName))
				{
					if (bInstanceEditable)
					{
						Variable.PropertyFlags |= CPF_Edit;
						Variable.PropertyFlags &= ~CPF_DisableEditOnInstance;
					}
					if (bExposed)
					{
						Variable.PropertyFlags |= CPF_Edit;
						FBlueprintEditorUtils::SetBlueprintVariableMetaData(
							Blueprint, Variable.VarName, nullptr, TEXT("ExposeOnSpawn"), TEXT("true"));
					}
					break;
				}
			}
			FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetStringField(TEXT("variable_name"), VariableName);
			Result->SetStringField(TEXT("variable_type"), PinTypeName(PinType));
			return Result;
		}

		if (Operation == TEXT("set_variable_flags"))
		{
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			Blueprint->Modify();
			const FString VariableName = GetString(Args, TEXT("variable_name"), GetString(Args, TEXT("name")));
			if (VariableName.IsEmpty())
			{
				return MakeErrorObject(TEXT("variable_name is required."));
			}

			bool bFound = false;
			FBPVariableDescription* TargetVariable = nullptr;
			for (FBPVariableDescription& Variable : Blueprint->NewVariables)
			{
				if (Variable.VarName == FName(*VariableName))
				{
					TargetVariable = &Variable;
					bFound = true;
					break;
				}
			}
			if (!bFound || !TargetVariable)
			{
				return MakeErrorObject(FString::Printf(TEXT("Variable not found: %s"), *VariableName));
			}

			if (Args.HasField(TEXT("is_instance_editable")))
			{
				if (GetBool(Args, TEXT("is_instance_editable"), false))
				{
					TargetVariable->PropertyFlags |= CPF_Edit;
					TargetVariable->PropertyFlags &= ~CPF_DisableEditOnInstance;
				}
				else
				{
					TargetVariable->PropertyFlags |= CPF_DisableEditOnInstance;
				}
			}
			if (Args.HasField(TEXT("is_exposed")))
			{
				FBlueprintEditorUtils::SetBlueprintVariableMetaData(
					Blueprint,
					FName(*VariableName),
					nullptr,
					TEXT("ExposeOnSpawn"),
					GetBool(Args, TEXT("is_exposed"), false) ? TEXT("true") : TEXT("false"));
			}

			FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetStringField(TEXT("variable_name"), VariableName);
			return Result;
		}

		if (Operation == TEXT("bind_widget_event"))
		{
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			UWidgetBlueprint* WidgetBlueprint = Cast<UWidgetBlueprint>(Blueprint);
			if (!WidgetBlueprint)
			{
				return MakeErrorObject(Error.IsEmpty()
					? TEXT("bind_widget_event requires a WidgetBlueprint asset.")
					: Error);
			}
			const FString ObjectName = GetString(Args, TEXT("widget_member_name"), GetString(Args, TEXT("object_name")));
			const FString PropertyName = GetString(Args, TEXT("event_name"), GetString(Args, TEXT("property_name")));
			FString FunctionName = GetString(Args, TEXT("function_name"));
			if (ObjectName.IsEmpty() || PropertyName.IsEmpty())
			{
				return MakeErrorObject(TEXT("widget_member_name and event_name are required."));
			}
			if (FunctionName.IsEmpty())
			{
				FunctionName = ObjectName + TEXT("_") + PropertyName;
			}
			if (!WidgetBlueprint->WidgetTree
				|| !WidgetBlueprint->WidgetTree->FindWidget(FName(*ObjectName)))
			{
				FString Available;
				if (WidgetBlueprint->WidgetTree)
				{
					WidgetBlueprint->WidgetTree->ForEachWidget([&Available](UWidget* Widget)
					{
						if (Widget)
						{
							Available += (Available.IsEmpty() ? TEXT("") : TEXT(", ")) + Widget->GetName();
						}
					});
				}
				return MakeErrorObject(FString::Printf(
					TEXT("Widget not found: %s. Available widgets: %s"),
					*ObjectName,
					Available.IsEmpty() ? TEXT("(none)") : *Available));
			}

			WidgetBlueprint->Modify();
			UEdGraph* FunctionGraph = FindGraphByName(WidgetBlueprint, FunctionName);
			if (!FunctionGraph)
			{
				FunctionGraph = FBlueprintEditorUtils::CreateNewGraph(
					WidgetBlueprint,
					FName(*FunctionName),
					UEdGraph::StaticClass(),
					UEdGraphSchema_K2::StaticClass());
				if (!FunctionGraph)
				{
					return MakeErrorObject(TEXT("Could not create the event handler function graph."));
				}
				FBlueprintEditorUtils::AddFunctionGraph<UFunction>(WidgetBlueprint, FunctionGraph, true, nullptr);
			}

			WidgetBlueprint->Bindings.RemoveAll(
				[&ObjectName, &PropertyName](const FDelegateEditorBinding& Existing)
				{
					return Existing.ObjectName == ObjectName
						&& Existing.PropertyName == FName(*PropertyName);
				});
			FDelegateEditorBinding Binding;
			Binding.ObjectName = ObjectName;
			Binding.PropertyName = FName(*PropertyName);
			Binding.FunctionName = FName(*FunctionName);
			Binding.Kind = EBindingKind::Function;
			WidgetBlueprint->Bindings.Add(Binding);
			FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WidgetBlueprint);

			FJsonObjectPtr Result;
			CompileBlueprint(WidgetBlueprint, Result);
			Result->SetStringField(TEXT("blueprint"), WidgetBlueprint->GetPathName());
			Result->SetStringField(TEXT("widget"), ObjectName);
			Result->SetStringField(TEXT("event_name"), PropertyName);
			Result->SetStringField(TEXT("function_name"), FunctionName);
			return Result;
		}

		if (Operation == TEXT("compile"))
		{
			int32 PieWorldCount = 0;
			if (IsPlayInEditorActive(PieWorldCount) && !UnsafeOperationsAllowed())
			{
				return MakeGuardRefusal(
					TEXT("pie-editor-mutation"),
					TEXT("Refuse editor-world mutations while Play In Editor is running"),
					FString::Printf(
						TEXT("Refusing to compile blueprint: Play In Editor is running (%d PIE world(s))."),
						PieWorldCount),
					TEXT("Stop Play In Editor first, then retry. Set UEV_ALLOW_UNSAFE_OPERATIONS=1 only for a deliberate, backed-up operation."));
			}
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			FJsonObjectPtr Result;
			CompileBlueprint(Blueprint, Result);
			Result->SetStringField(TEXT("blueprint"), Blueprint->GetPathName());
			return Result;
		}

		if (Operation == TEXT("save"))
		{
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			if (!SaveAsset(Blueprint, Error))
			{
				return MakeErrorObject(Error);
			}
			return MakeSuccess();
		}

		return MakeErrorObject(FString::Printf(TEXT("Unknown blueprint graph operation: %s"), *Operation));
	}

	FJsonObjectPtr HandleBlueprintOperation(const FString& Operation, const FJsonObject& Args)
	{
		// Every in-place mutation of an existing blueprint now runs inside one editor transaction, so a
		// single undo reverts a whole action. This is a deliberate behavior change for the actions that
		// already existed before 1.7 (they used to open no transaction at all): undo previously reverted
		// nothing, now it reverts the whole call.
		static const TSet<FString> Mutations = {
			TEXT("add_component"), TEXT("add_node"), TEXT("connect_nodes"), TEXT("disconnect_nodes"),
			TEXT("delete_node"), TEXT("set_pin_default"), TEXT("add_variable"), TEXT("set_variable_flags"),
			TEXT("create_function"), TEXT("bind_widget_event"), TEXT("set_component_property"), TEXT("set_static_mesh"),
			TEXT("set_physics_properties"), TEXT("set_collision_profile"), TEXT("set_collision_response"),
			TEXT("set_function_signature"), TEXT("rename_function"), TEXT("delete_function"),
			TEXT("add_local_variable"), TEXT("update_local_variable"), TEXT("remove_local_variable"),
			TEXT("create_macro"), TEXT("set_macro_signature"), TEXT("rename_macro"), TEXT("delete_macro"),
			TEXT("reset_construction_script")
		};
		// FBlueprintEditorUtils::AddLocalVariable opens its own transaction and a nested FScopedTransaction
		// trips ensure(!GIsTransacting), so that action keeps its single engine-owned transaction.
		// create_macro_library creates and saves a brand-new asset and owns that lifecycle itself.
		static const TSet<FString> EngineOwnedTransaction = {
			TEXT("add_local_variable")
		};
		const bool bMutating = Mutations.Contains(Operation);

		FJsonObjectPtr Result;
		bool bSuccess = false;
		{
			TSharedPtr<FScopedTransaction> Transaction;
			if (bMutating && !EngineOwnedTransaction.Contains(Operation) && GEditor && !GIsTransacting)
			{
				Transaction = MakeShared<FScopedTransaction>(
					FText::FromString(FString::Printf(TEXT("UEV blueprint %s"), *Operation)));
			}
			Result = HandleBlueprintOperationInternal(Operation, Args);
			if (!Result.IsValid() || !Result->TryGetBoolField(TEXT("success"), bSuccess) || !bSuccess)
			{
				if (Transaction.IsValid())
				{
					Transaction->Cancel();
				}
				return Result;
			}
			// The transaction ends here (destructor) so the save below sees the final, committed state.
		}
		if (!bMutating)
		{
			return Result;
		}
		// The target asset is not always named by blueprint_name/asset_path: the macro actions
		// address the macro library instead, so resolve that alias before finalizing.
		TSharedPtr<FJsonObject> FinalizeArgs = MakeShared<FJsonObject>();
		for (const TPair<FString, TSharedPtr<FJsonValue>>& Pair : Args.Values)
		{
			FinalizeArgs->Values.Add(Pair.Key, Pair.Value);
		}
		if (!FinalizeArgs->HasField(TEXT("blueprint_name")) && !FinalizeArgs->HasField(TEXT("asset_path")))
		{
			const FString LibraryPath = GetString(Args, TEXT("macro_library"), GetString(Args, TEXT("library_path")));
			if (!LibraryPath.IsEmpty())
			{
				FinalizeArgs->SetStringField(TEXT("blueprint_name"), LibraryPath);
			}
		}
		FString Error;
		UBlueprint* Blueprint = LoadBlueprint(*FinalizeArgs, Error);
		if (!Blueprint)
		{
			return Result;
		}
		Result = FinalizeAssetEdit(Blueprint, *FinalizeArgs, Result);

		// Macro edits also restructure every Blueprint that instances the macro; persist those too so a
		// reload cannot resurrect stale instance pins.
		const TArray<TSharedPtr<FJsonValue>>* AffectedBlueprints = nullptr;
		if (GetBool(*FinalizeArgs, TEXT("save"), true) && Result.IsValid() && Result->TryGetArrayField(TEXT("affected_blueprints"), AffectedBlueprints))
		{
			TArray<TSharedPtr<FJsonValue>> SavedAffected;
			TArray<TSharedPtr<FJsonValue>> SaveWarnings;
			for (const TSharedPtr<FJsonValue>& Entry : *AffectedBlueprints)
			{
				FString Path;
				if (!Entry.IsValid() || !Entry->TryGetString(Path) || Path.IsEmpty())
				{
					continue;
				}
				UBlueprint* Affected = LoadObject<UBlueprint>(nullptr, *Path);
				if (!Affected)
				{
					SaveWarnings.Add(MakeShared<FJsonValueString>(FString::Printf(TEXT("Could not load affected blueprint: %s"), *Path)));
					continue;
				}
				FString SaveError;
				if (SaveAsset(Affected, SaveError))
				{
					SavedAffected.Add(MakeShared<FJsonValueString>(Affected->GetPathName()));
				}
				else
				{
					SaveWarnings.Add(MakeShared<FJsonValueString>(FString::Printf(TEXT("Could not save affected blueprint %s: %s"), *Path, *SaveError)));
				}
			}
			Result->SetArrayField(TEXT("affected_blueprints_saved"), SavedAffected);
			if (SaveWarnings.Num() > 0)
			{
				Result->SetArrayField(TEXT("save_warnings"), SaveWarnings);
			}
		}
		return Result;
	}
}
