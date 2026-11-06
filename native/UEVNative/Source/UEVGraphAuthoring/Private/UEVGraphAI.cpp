#include "UEVGraphAI.h"

#include "UEVGraphShared.h"

#include "AIController.h"
#include "BehaviorTree/BTCompositeNode.h"
#include "BehaviorTree/BTDecorator.h"
#include "BehaviorTree/BTNode.h"
#include "BehaviorTree/BTService.h"
#include "BehaviorTree/BTTaskNode.h"
#include "BehaviorTree/BehaviorTree.h"
#include "BehaviorTree/BehaviorTreeComponent.h"
#include "BehaviorTree/Blackboard/BlackboardKeyType_Bool.h"
#include "BehaviorTree/Blackboard/BlackboardKeyType_Class.h"
#include "BehaviorTree/Blackboard/BlackboardKeyType_Float.h"
#include "BehaviorTree/Blackboard/BlackboardKeyType_Int.h"
#include "BehaviorTree/Blackboard/BlackboardKeyType_Name.h"
#include "BehaviorTree/Blackboard/BlackboardKeyType_Object.h"
#include "BehaviorTree/Blackboard/BlackboardKeyType_Rotator.h"
#include "BehaviorTree/Blackboard/BlackboardKeyType_String.h"
#include "BehaviorTree/Blackboard/BlackboardKeyType_Vector.h"
#include "BehaviorTree/BlackboardData.h"
#include "Dom/JsonObject.h"
#include "Editor.h"
#include "Engine/Blueprint.h"
#include "Engine/EngineTypes.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "GameFramework/Pawn.h"

namespace
{
	using FJsonObjectPtr = UEVGraph::FJsonObjectPtr;
	using FJsonValuePtr = UEVGraph::FJsonValuePtr;

	void AddObjectValue(TArray<FJsonValuePtr>& Values, const FJsonObjectPtr& Object)
	{
		if (Object.IsValid())
		{
			Values.Add(MakeShared<FJsonValueObject>(Object));
		}
	}

	void AddStringValue(TArray<FJsonValuePtr>& Values, const FString& Value)
	{
		Values.Add(MakeShared<FJsonValueString>(Value));
	}

	void SetWarnings(FJsonObjectPtr& Object, const TArray<FString>& Warnings)
	{
		TArray<FJsonValuePtr> Values;
		for (const FString& Warning : Warnings)
		{
			AddStringValue(Values, Warning);
		}
		Object->SetArrayField(TEXT("warnings"), Values);
	}

	FJsonObjectPtr MakeAssetReference(const UObject* Asset)
	{
		FJsonObjectPtr Reference = UEVGraph::MakeObject();
		if (!Asset)
		{
			return Reference;
		}
		Reference->SetStringField(TEXT("name"), Asset->GetName());
		Reference->SetStringField(TEXT("path"), Asset->GetPathName());
		Reference->SetStringField(TEXT("class"), Asset->GetClass()->GetName());
		return Reference;
	}

	FString KeyTypeShortName(const UBlackboardKeyType* KeyType)
	{
		if (!KeyType)
		{
			return TEXT("None");
		}
		FString ClassName = KeyType->GetClass()->GetName();
		ClassName.RemoveFromStart(TEXT("BlackboardKeyType_"));
		return ClassName;
	}

	FString KeyBaseClassPath(const FBlackboardEntry& Entry)
	{
		if (const UBlackboardKeyType_Object* ObjectKey = Cast<UBlackboardKeyType_Object>(Entry.KeyType))
		{
			return ObjectKey->BaseClass ? ObjectKey->BaseClass->GetPathName() : FString();
		}
		if (const UBlackboardKeyType_Class* ClassKey = Cast<UBlackboardKeyType_Class>(Entry.KeyType))
		{
			return ClassKey->BaseClass ? ClassKey->BaseClass->GetPathName() : FString();
		}
		return FString();
	}

	FJsonObjectPtr SerializeBlackboardKey(const FBlackboardEntry& Entry)
	{
		FJsonObjectPtr Key = UEVGraph::MakeObject();
		Key->SetStringField(TEXT("name"), Entry.EntryName.ToString());
		Key->SetStringField(TEXT("type"), KeyTypeShortName(Entry.KeyType));
		Key->SetBoolField(TEXT("instance_synced"), Entry.bInstanceSynced != 0);
		Key->SetStringField(TEXT("key_type_class"), Entry.KeyType ? Entry.KeyType->GetClass()->GetPathName() : FString());
#if WITH_EDITORONLY_DATA
		Key->SetStringField(TEXT("category"), Entry.EntryCategory.ToString());
		Key->SetStringField(TEXT("description"), Entry.EntryDescription);
#else
		Key->SetStringField(TEXT("category"), FString());
		Key->SetStringField(TEXT("description"), FString());
#endif
		const FString BaseClassPath = KeyBaseClassPath(Entry);
		if (!BaseClassPath.IsEmpty())
		{
			Key->SetStringField(TEXT("base_class"), BaseClassPath);
		}
		return Key;
	}

	FJsonObjectPtr SerializeBlackboard(UBlackboardData* Blackboard)
	{
		FJsonObjectPtr Info = UEVGraph::MakeObject();
		if (!Blackboard)
		{
			return Info;
		}
		Info->SetStringField(TEXT("name"), Blackboard->GetName());
		Info->SetStringField(TEXT("path"), Blackboard->GetPathName());
		Info->SetStringField(TEXT("parent"), Blackboard->Parent ? Blackboard->Parent->GetPathName() : FString());
		Info->SetNumberField(TEXT("local_key_count"), Blackboard->Keys.Num());
		Info->SetNumberField(TEXT("key_count"), Blackboard->GetNumKeys());
		Info->SetBoolField(TEXT("has_synchronized_keys"), Blackboard->HasSynchronizedKeys());

		TArray<FJsonValuePtr> Keys;
		for (const FBlackboardEntry& Entry : Blackboard->Keys)
		{
			AddObjectValue(Keys, SerializeBlackboardKey(Entry));
		}
		Info->SetArrayField(TEXT("keys"), Keys);
		return Info;
	}

	const UBlackboardData* FindKeyInParentChain(const UBlackboardData* Blackboard, const FName& KeyName, FString& OutOwnerPath)
	{
		if (!Blackboard)
		{
			return nullptr;
		}
		const UBlackboardData* Parent = Blackboard->Parent;
		int32 Guard = 0;
		while (Parent && Guard < 32)
		{
			for (const FBlackboardEntry& Entry : Parent->Keys)
			{
				if (Entry.EntryName == KeyName)
				{
					OutOwnerPath = Parent->GetPathName();
					return Parent;
				}
			}
			Parent = Parent->Parent;
			++Guard;
		}
		return nullptr;
	}

	UClass* ResolveBlackboardKeyTypeClass(const FString& KeyType, FString& OutError)
	{
		const FString Normalized = KeyType.TrimStartAndEnd().ToLower();
		if (Normalized == TEXT("bool") || Normalized == TEXT("boolean"))
		{
			return UBlackboardKeyType_Bool::StaticClass();
		}
		if (Normalized == TEXT("int") || Normalized == TEXT("integer") || Normalized == TEXT("int32"))
		{
			return UBlackboardKeyType_Int::StaticClass();
		}
		if (Normalized == TEXT("float") || Normalized == TEXT("number"))
		{
			return UBlackboardKeyType_Float::StaticClass();
		}
		if (Normalized == TEXT("vector"))
		{
			return UBlackboardKeyType_Vector::StaticClass();
		}
		if (Normalized == TEXT("rotator"))
		{
			return UBlackboardKeyType_Rotator::StaticClass();
		}
		if (Normalized == TEXT("name"))
		{
			return UBlackboardKeyType_Name::StaticClass();
		}
		if (Normalized == TEXT("string") || Normalized == TEXT("text"))
		{
			return UBlackboardKeyType_String::StaticClass();
		}
		if (Normalized == TEXT("object") || Normalized == TEXT("actor"))
		{
			return UBlackboardKeyType_Object::StaticClass();
		}
		if (Normalized == TEXT("class"))
		{
			return UBlackboardKeyType_Class::StaticClass();
		}

		OutError = FString::Printf(
			TEXT("Unsupported blackboard key type: %s. Use Bool, Int, Float, Vector, Rotator, Name, String, Object or Class."),
			KeyType.IsEmpty() ? TEXT("(empty)") : *KeyType);
		return nullptr;
	}

	FJsonObjectPtr SerializeBehaviorTreeReference(UBTNode* Node)
	{
		FJsonObjectPtr Reference = UEVGraph::MakeObject();
		if (!Node)
		{
			return Reference;
		}
		Reference->SetStringField(TEXT("class"), Node->GetClass()->GetPathName());
		Reference->SetStringField(TEXT("class_name"), Node->GetClass()->GetName());
		Reference->SetStringField(TEXT("name"), Node->GetNodeName());
		Reference->SetStringField(TEXT("description"), Node->GetStaticDescription());
		return Reference;
	}

	FJsonObjectPtr SerializeBehaviorTreeNode(UBTNode* Node, int32 Depth, TSet<const UBTNode*>& Visited, TArray<FString>& Warnings, int32& NodeCount, int32& MaxDepth)
	{
		FJsonObjectPtr NodeJson = UEVGraph::MakeObject();
		if (!Node)
		{
			NodeJson->SetStringField(TEXT("kind"), TEXT("empty"));
			return NodeJson;
		}

		++NodeCount;
		MaxDepth = FMath::Max(MaxDepth, Depth);

		const bool bComposite = Node->IsA(UBTCompositeNode::StaticClass());
		const bool bTask = Node->IsA(UBTTaskNode::StaticClass());
		NodeJson->SetStringField(TEXT("kind"), bComposite ? TEXT("composite") : (bTask ? TEXT("task") : TEXT("node")));
		NodeJson->SetStringField(TEXT("class"), Node->GetClass()->GetPathName());
		NodeJson->SetStringField(TEXT("class_name"), Node->GetClass()->GetName());
		NodeJson->SetStringField(TEXT("name"), Node->GetNodeName());
		NodeJson->SetStringField(TEXT("description"), Node->GetStaticDescription());
		NodeJson->SetNumberField(TEXT("depth"), Depth);
		NodeJson->SetNumberField(TEXT("execution_index"), static_cast<double>(Node->GetExecutionIndex()));

		if (Visited.Contains(Node))
		{
			NodeJson->SetBoolField(TEXT("repeated"), true);
			Warnings.Add(FString::Printf(TEXT("Behavior tree node %s is referenced more than once; its children were described only once."), *Node->GetNodeName()));
			return NodeJson;
		}
		Visited.Add(Node);

		if (Depth >= 64)
		{
			Warnings.Add(FString::Printf(TEXT("Behavior tree depth reached 64 at %s; deeper children were not described."), *Node->GetNodeName()));
			return NodeJson;
		}

		if (UBTCompositeNode* Composite = Cast<UBTCompositeNode>(Node))
		{
			TArray<FJsonValuePtr> Services;
			for (UBTService* Service : Composite->Services)
			{
				AddObjectValue(Services, SerializeBehaviorTreeReference(Service));
			}
			NodeJson->SetArrayField(TEXT("services"), Services);

			TArray<FJsonValuePtr> Children;
			for (int32 ChildIndex = 0; ChildIndex < Composite->Children.Num(); ++ChildIndex)
			{
				const FBTCompositeChild& Child = Composite->Children[ChildIndex];
				FJsonObjectPtr ChildJson = UEVGraph::MakeObject();
				ChildJson->SetNumberField(TEXT("index"), ChildIndex);

				TArray<FJsonValuePtr> Decorators;
				for (UBTDecorator* Decorator : Child.Decorators)
				{
					AddObjectValue(Decorators, SerializeBehaviorTreeReference(Decorator));
				}
				ChildJson->SetArrayField(TEXT("decorators"), Decorators);

				UBTNode* ChildNode = Child.ChildComposite;
				if (!ChildNode)
				{
					ChildNode = Child.ChildTask;
				}

				if (ChildNode)
				{
					ChildJson->SetObjectField(TEXT("node"), SerializeBehaviorTreeNode(ChildNode, Depth + 1, Visited, Warnings, NodeCount, MaxDepth));
				}
				else
				{
					ChildJson->SetStringField(TEXT("kind"), TEXT("empty"));
					Warnings.Add(FString::Printf(TEXT("Composite %s has an empty child slot at index %d."), *Node->GetNodeName(), ChildIndex));
				}
				AddObjectValue(Children, ChildJson);
			}
			NodeJson->SetArrayField(TEXT("children"), Children);
			NodeJson->SetNumberField(TEXT("child_count"), Composite->Children.Num());
		}
		else if (UBTTaskNode* Task = Cast<UBTTaskNode>(Node))
		{
			TArray<FJsonValuePtr> Services;
			for (UBTService* Service : Task->Services)
			{
				AddObjectValue(Services, SerializeBehaviorTreeReference(Service));
			}
			NodeJson->SetArrayField(TEXT("services"), Services);
		}

		return NodeJson;
	}

	FString ActorLabelOf(const AActor* Actor)
	{
#if WITH_EDITOR
		return Actor ? Actor->GetActorLabel() : FString();
#else
		return FString();
#endif
	}

	AAIController* FindControllerInWorld(UWorld* World, const FString& Target)
	{
		if (!World || Target.IsEmpty())
		{
			return nullptr;
		}
		for (TActorIterator<AAIController> It(World); It; ++It)
		{
			AAIController* Controller = *It;
			if (!Controller)
			{
				continue;
			}
			if (Controller->GetName().Equals(Target, ESearchCase::IgnoreCase))
			{
				return Controller;
			}
			if (Controller->GetPathName().Equals(Target, ESearchCase::IgnoreCase))
			{
				return Controller;
			}
			if (ActorLabelOf(Controller).Equals(Target, ESearchCase::IgnoreCase))
			{
				return Controller;
			}
		}
		return nullptr;
	}

	APawn* FindPawnInWorld(UWorld* World, const FString& Target)
	{
		if (!World || Target.IsEmpty())
		{
			return nullptr;
		}
		for (TActorIterator<APawn> It(World); It; ++It)
		{
			APawn* Pawn = *It;
			if (!Pawn)
			{
				continue;
			}
			if (Pawn->GetName().Equals(Target, ESearchCase::IgnoreCase))
			{
				return Pawn;
			}
			if (Pawn->GetPathName().Equals(Target, ESearchCase::IgnoreCase))
			{
				return Pawn;
			}
			if (ActorLabelOf(Pawn).Equals(Target, ESearchCase::IgnoreCase))
			{
				return Pawn;
			}
		}
		return nullptr;
	}

	UClass* ResolveControllerClass(const FString& Target, FString& OutError)
	{
		FString AssetError;
		UBlueprint* Blueprint = Cast<UBlueprint>(UEVGraph::LoadAsset(Target, UBlueprint::StaticClass(), AssetError));
		if (Blueprint)
		{
			UClass* GeneratedClass = Blueprint->GeneratedClass;
			if (!GeneratedClass)
			{
				OutError = FString::Printf(TEXT("Blueprint %s has no generated class; compile it before running a behavior tree."), *Target);
				return nullptr;
			}
			if (!GeneratedClass->IsChildOf(AAIController::StaticClass()))
			{
				OutError = FString::Printf(TEXT("Blueprint %s is not an AI controller."), *Target);
				return nullptr;
			}
			return GeneratedClass;
		}
		return UEVGraph::ResolveClass(Target, AAIController::StaticClass(), OutError);
	}

	FJsonObjectPtr MakeFailure(const FString& Message, const TArray<FString>& Warnings)
	{
		FJsonObjectPtr Result = UEVGraph::MakeErrorObject(Message);
		SetWarnings(Result, Warnings);
		return Result;
	}
}

FString UUEVGraphAI::DescribeBlackboard(const FString& BlackboardPath)
{
	FString Error;
	UBlackboardData* Blackboard = Cast<UBlackboardData>(UEVGraph::LoadAsset(BlackboardPath, UBlackboardData::StaticClass(), Error));
	if (!Blackboard)
	{
		return UEVGraph::Serialize(UEVGraph::MakeErrorObject(Error));
	}

	FJsonObjectPtr Result = UEVGraph::MakeSuccess();
	Result->SetObjectField(TEXT("blackboard"), SerializeBlackboard(Blackboard));
	return UEVGraph::Serialize(Result);
}

FString UUEVGraphAI::AddBlackboardKey(const FString& BlackboardPath, const FString& KeyName, const FString& KeyType, bool bInstanceSynced, const FString& Category, const FString& BaseClassPath)
{
	FString Error;
	UBlackboardData* Blackboard = Cast<UBlackboardData>(UEVGraph::LoadAsset(BlackboardPath, UBlackboardData::StaticClass(), Error));
	if (!Blackboard)
	{
		return UEVGraph::Serialize(UEVGraph::MakeErrorObject(Error));
	}

	const FString TrimmedName = KeyName.TrimStartAndEnd();
	if (TrimmedName.IsEmpty())
	{
		return UEVGraph::Serialize(UEVGraph::MakeErrorObject(TEXT("A blackboard key name is required.")));
	}

	const FName EntryName(*TrimmedName);
	for (const FBlackboardEntry& Entry : Blackboard->Keys)
	{
		if (Entry.EntryName == EntryName)
		{
			return UEVGraph::Serialize(UEVGraph::MakeErrorObject(FString::Printf(TEXT("Key %s already exists on blackboard %s."), *TrimmedName, *Blackboard->GetName())));
		}
	}

	FString ParentOwnerPath;
	if (FindKeyInParentChain(Blackboard, EntryName, ParentOwnerPath))
	{
		return UEVGraph::Serialize(UEVGraph::MakeErrorObject(FString::Printf(
			TEXT("Key %s is inherited from parent blackboard %s; add or change it on the parent instead."),
			*TrimmedName,
			*ParentOwnerPath)));
	}

	UClass* KeyTypeClass = ResolveBlackboardKeyTypeClass(KeyType, Error);
	if (!KeyTypeClass)
	{
		return UEVGraph::Serialize(UEVGraph::MakeErrorObject(Error));
	}

	const bool bWantsBaseClass = !BaseClassPath.TrimStartAndEnd().IsEmpty();
	const bool bSupportsBaseClass = KeyTypeClass == UBlackboardKeyType_Object::StaticClass() || KeyTypeClass == UBlackboardKeyType_Class::StaticClass();
	if (bWantsBaseClass && !bSupportsBaseClass)
	{
		return UEVGraph::Serialize(UEVGraph::MakeErrorObject(FString::Printf(
			TEXT("base_class is only supported for Object and Class blackboard keys, not %s."),
			*KeyType.TrimStartAndEnd())));
	}

	UClass* BaseClass = nullptr;
	if (bWantsBaseClass)
	{
		BaseClass = UEVGraph::ResolveClass(BaseClassPath, UObject::StaticClass(), Error);
		if (!BaseClass)
		{
			return UEVGraph::Serialize(UEVGraph::MakeErrorObject(Error));
		}
	}

	UBlackboardKeyType* KeyTypeObject = NewObject<UBlackboardKeyType>(Blackboard, KeyTypeClass, NAME_None, RF_Transactional);
	if (!KeyTypeObject)
	{
		return UEVGraph::Serialize(UEVGraph::MakeErrorObject(FString::Printf(TEXT("Could not create a %s blackboard key type."), *KeyTypeClass->GetName())));
	}

	if (BaseClass)
	{
		if (UBlackboardKeyType_Object* ObjectKey = Cast<UBlackboardKeyType_Object>(KeyTypeObject))
		{
			ObjectKey->BaseClass = BaseClass;
		}
		else if (UBlackboardKeyType_Class* ClassKey = Cast<UBlackboardKeyType_Class>(KeyTypeObject))
		{
			ClassKey->BaseClass = BaseClass;
		}
	}

	FBlackboardEntry Entry;
	Entry.EntryName = EntryName;
	Entry.KeyType = KeyTypeObject;
	Entry.bInstanceSynced = bInstanceSynced ? 1 : 0;
#if WITH_EDITORONLY_DATA
	const FString TrimmedCategory = Category.TrimStartAndEnd();
	Entry.EntryCategory = TrimmedCategory.IsEmpty() ? NAME_None : FName(*TrimmedCategory);
	Entry.EntryDescription = FString();
#endif

	Blackboard->Modify();
	Blackboard->Keys.Add(Entry);
	Blackboard->MarkPackageDirty();
	Blackboard->UpdateKeyIDs();
	Blackboard->UpdateIfHasSynchronizedKeys();
	Blackboard->UpdateParentKeys();
	Blackboard->PropagateKeyChangesToDerivedBlackboardAssets();

	FJsonObjectPtr Result = UEVGraph::MakeSuccess();
	Result->SetObjectField(TEXT("key"), SerializeBlackboardKey(Blackboard->Keys.Last()));
	Result->SetObjectField(TEXT("blackboard"), SerializeBlackboard(Blackboard));

	FJsonObject EmptyArgs;
	return UEVGraph::Serialize(UEVGraph::FinalizeAssetEdit(Blackboard, EmptyArgs, Result));
}

FString UUEVGraphAI::RemoveBlackboardKey(const FString& BlackboardPath, const FString& KeyName)
{
	FString Error;
	UBlackboardData* Blackboard = Cast<UBlackboardData>(UEVGraph::LoadAsset(BlackboardPath, UBlackboardData::StaticClass(), Error));
	if (!Blackboard)
	{
		return UEVGraph::Serialize(UEVGraph::MakeErrorObject(Error));
	}

	const FString TrimmedName = KeyName.TrimStartAndEnd();
	if (TrimmedName.IsEmpty())
	{
		return UEVGraph::Serialize(UEVGraph::MakeErrorObject(TEXT("A blackboard key name is required.")));
	}

	const FName EntryName(*TrimmedName);
	int32 KeyIndex = INDEX_NONE;
	for (int32 Index = 0; Index < Blackboard->Keys.Num(); ++Index)
	{
		if (Blackboard->Keys[Index].EntryName == EntryName)
		{
			KeyIndex = Index;
			break;
		}
	}

	if (KeyIndex == INDEX_NONE)
	{
		FString ParentOwnerPath;
		if (FindKeyInParentChain(Blackboard, EntryName, ParentOwnerPath))
		{
			return UEVGraph::Serialize(UEVGraph::MakeErrorObject(FString::Printf(
				TEXT("Key %s is inherited from parent blackboard %s and cannot be removed here."),
				*TrimmedName,
				*ParentOwnerPath)));
		}
		return UEVGraph::Serialize(UEVGraph::MakeErrorObject(FString::Printf(TEXT("Key %s was not found on blackboard %s."), *TrimmedName, *Blackboard->GetName())));
	}

	Blackboard->Modify();
	Blackboard->Keys.RemoveAt(KeyIndex);
	Blackboard->MarkPackageDirty();
	Blackboard->UpdateKeyIDs();
	Blackboard->UpdateIfHasSynchronizedKeys();
	Blackboard->UpdateParentKeys();
	Blackboard->PropagateKeyChangesToDerivedBlackboardAssets();

	FJsonObjectPtr Result = UEVGraph::MakeSuccess();
	Result->SetStringField(TEXT("removed_key"), TrimmedName);
	Result->SetObjectField(TEXT("blackboard"), SerializeBlackboard(Blackboard));
	SetWarnings(Result, TArray<FString>{FString::Printf(TEXT("Behavior trees that reference %s may now point at a missing blackboard key."), *TrimmedName)});

	FJsonObject EmptyArgs;
	return UEVGraph::Serialize(UEVGraph::FinalizeAssetEdit(Blackboard, EmptyArgs, Result));
}

FString UUEVGraphAI::DescribeBehaviorTree(const FString& BehaviorTreePath)
{
	FString Error;
	UBehaviorTree* BehaviorTree = Cast<UBehaviorTree>(UEVGraph::LoadAsset(BehaviorTreePath, UBehaviorTree::StaticClass(), Error));
	if (!BehaviorTree)
	{
		return UEVGraph::Serialize(UEVGraph::MakeErrorObject(Error));
	}

	FJsonObjectPtr Result = UEVGraph::MakeSuccess();
	Result->SetObjectField(TEXT("behavior_tree"), MakeAssetReference(BehaviorTree));

	TArray<FString> Warnings;
	TSet<const UBTNode*> Visited;
	int32 NodeCount = 0;
	int32 MaxDepth = 0;

	if (BehaviorTree->RootNode)
	{
		FJsonObjectPtr RootJson = SerializeBehaviorTreeNode(BehaviorTree->RootNode, 0, Visited, Warnings, NodeCount, MaxDepth);
		TArray<FJsonValuePtr> RootDecorators;
		for (UBTDecorator* Decorator : BehaviorTree->RootDecorators)
		{
			AddObjectValue(RootDecorators, SerializeBehaviorTreeReference(Decorator));
		}
		RootJson->SetArrayField(TEXT("decorators"), RootDecorators);
		Result->SetObjectField(TEXT("root"), RootJson);
	}
	else
	{
		Result->SetBoolField(TEXT("success"), false);
		Result->SetStringField(TEXT("message"), FString::Printf(
			TEXT("Behavior tree %s has no root node. Open and compile it in the behavior tree editor, then inspect it again."),
			*BehaviorTree->GetName()));
		Warnings.Add(TEXT("The behavior tree asset has no compiled root node."));
	}

	if (BehaviorTree->BlackboardAsset)
	{
		Result->SetObjectField(TEXT("blackboard"), SerializeBlackboard(BehaviorTree->BlackboardAsset));
	}
	else
	{
		Warnings.Add(TEXT("The behavior tree has no blackboard asset assigned."));
	}

	Result->SetNumberField(TEXT("node_count"), NodeCount);
	Result->SetNumberField(TEXT("max_depth"), MaxDepth);
	SetWarnings(Result, Warnings);
	return UEVGraph::Serialize(Result);
}

FString UUEVGraphAI::AssignBehaviorTree(const FString& BehaviorTreePath, const FString& Target, const FString& PawnName, bool bSpawnIfMissing, bool bPossess)
{
	FString Error;
	UBehaviorTree* BehaviorTree = Cast<UBehaviorTree>(UEVGraph::LoadAsset(BehaviorTreePath, UBehaviorTree::StaticClass(), Error));
	if (!BehaviorTree)
	{
		return UEVGraph::Serialize(UEVGraph::MakeErrorObject(Error));
	}

	if (!GEditor)
	{
		return UEVGraph::Serialize(UEVGraph::MakeErrorObject(TEXT("The editor is not available; behavior tree assignment requires an editor session.")));
	}

	UWorld* World = nullptr;
	FString WorldKind = TEXT("editor");
	if (FWorldContext* PIEContext = GEditor->GetPIEWorldContext())
	{
		World = PIEContext->World();
		if (World)
		{
			WorldKind = TEXT("pie");
		}
	}
	if (!World)
	{
		World = GEditor->GetEditorWorldContext().World();
		WorldKind = TEXT("editor");
	}
	if (!World)
	{
		return UEVGraph::Serialize(UEVGraph::MakeErrorObject(TEXT("No editor or play world is available for AI assignment.")));
	}

	TArray<FString> Warnings;
	const FString TrimmedTarget = Target.TrimStartAndEnd();
	if (TrimmedTarget.IsEmpty())
	{
		return UEVGraph::Serialize(MakeFailure(TEXT("A target AI controller actor name or controller Blueprint path is required."), Warnings));
	}

	AAIController* Controller = FindControllerInWorld(World, TrimmedTarget);
	FString Source = TEXT("placed_actor");
	bool bSpawned = false;

	if (!Controller)
	{
		FString ClassError;
		UClass* ControllerClass = ResolveControllerClass(TrimmedTarget, ClassError);
		if (!ControllerClass)
		{
			return UEVGraph::Serialize(MakeFailure(ClassError, Warnings));
		}
		if (ControllerClass->HasAnyClassFlags(CLASS_Abstract))
		{
			return UEVGraph::Serialize(MakeFailure(FString::Printf(TEXT("Controller class %s is abstract and cannot be spawned."), *ControllerClass->GetName()), Warnings));
		}

		for (TActorIterator<AAIController> It(World); It; ++It)
		{
			if (It->IsA(ControllerClass))
			{
				Controller = *It;
				Source = TEXT("placed_instance");
				break;
			}
		}

		if (!Controller)
		{
			if (!bSpawnIfMissing)
			{
				return UEVGraph::Serialize(MakeFailure(FString::Printf(
					TEXT("No placed %s exists in %s and spawn_if_missing is false."),
					*ControllerClass->GetName(),
					*World->GetName()),
					Warnings));
			}

			FActorSpawnParameters SpawnParameters;
			SpawnParameters.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
			const FTransform SpawnTransform = FTransform::Identity;
			Controller = Cast<AAIController>(World->SpawnActor(ControllerClass, &SpawnTransform, SpawnParameters));
			if (!Controller)
			{
				return UEVGraph::Serialize(MakeFailure(FString::Printf(TEXT("Failed to spawn an instance of %s in %s."), *ControllerClass->GetName(), *World->GetName()), Warnings));
			}

			bSpawned = true;
			Source = Controller->GetClass()->ClassGeneratedBy ? TEXT("spawned_blueprint") : TEXT("spawned_class");
			Warnings.Add(FString::Printf(
				TEXT("Spawned %s (%s) into the %s world; save the level to keep it."),
				*Controller->GetName(),
				*Controller->GetClass()->GetName(),
				*WorldKind));
		}
	}

	const FString TrimmedPawn = PawnName.TrimStartAndEnd();
	APawn* Pawn = nullptr;
	if (!TrimmedPawn.IsEmpty())
	{
		Pawn = FindPawnInWorld(World, TrimmedPawn);
		if (!Pawn)
		{
			return UEVGraph::Serialize(MakeFailure(FString::Printf(TEXT("Pawn not found in %s: %s"), *World->GetName(), *PawnName), Warnings));
		}
		if (!bPossess)
		{
			Warnings.Add(FString::Printf(TEXT("Pawn %s was found but possess is false; it was left unpossessed."), *ActorLabelOf(Pawn)));
		}
	}

	bool bPossessed = false;
	if (Pawn && bPossess)
	{
		Controller->Possess(Pawn);
		bPossessed = Controller->GetPawn() == Pawn;
		if (!bPossessed)
		{
			Warnings.Add(TEXT("The controller rejected possession; it may lack authority or already control another pawn."));
		}
	}

	UBehaviorTreeComponent* ExistingComponent = Cast<UBehaviorTreeComponent>(Controller->GetBrainComponent());
	UBehaviorTree* PreviousTree = ExistingComponent ? ExistingComponent->GetCurrentTree() : nullptr;

	const bool bRan = Controller->RunBehaviorTree(BehaviorTree);

	UBehaviorTreeComponent* BrainComponent = Cast<UBehaviorTreeComponent>(Controller->GetBrainComponent());
	UBehaviorTree* CurrentTree = BrainComponent ? BrainComponent->GetCurrentTree() : nullptr;
	const bool bRunning = BrainComponent ? BrainComponent->IsRunning() : false;
	const bool bStarted = bRan && CurrentTree == BehaviorTree;

	FJsonObjectPtr Result = UEVGraph::MakeSuccess();
	Result->SetObjectField(TEXT("behavior_tree"), MakeAssetReference(BehaviorTree));
	Result->SetStringField(TEXT("world"), WorldKind);
	Result->SetStringField(TEXT("world_name"), World->GetName());

	FJsonObjectPtr ControllerJson = UEVGraph::MakeObject();
	ControllerJson->SetStringField(TEXT("name"), Controller->GetName());
	ControllerJson->SetStringField(TEXT("class"), Controller->GetClass()->GetName());
	ControllerJson->SetStringField(TEXT("class_path"), Controller->GetClass()->GetPathName());
	ControllerJson->SetStringField(TEXT("label"), ActorLabelOf(Controller));
	ControllerJson->SetStringField(TEXT("path"), Controller->GetPathName());
	ControllerJson->SetStringField(TEXT("source"), Source);
	ControllerJson->SetBoolField(TEXT("spawned"), bSpawned);
	if (UBlueprint* OwningBlueprint = Cast<UBlueprint>(Controller->GetClass()->ClassGeneratedBy))
	{
		ControllerJson->SetStringField(TEXT("blueprint"), OwningBlueprint->GetPathName());
	}
	Result->SetObjectField(TEXT("controller"), ControllerJson);

	if (Pawn)
	{
		FJsonObjectPtr PawnJson = UEVGraph::MakeObject();
		PawnJson->SetStringField(TEXT("name"), Pawn->GetName());
		PawnJson->SetStringField(TEXT("class"), Pawn->GetClass()->GetName());
		PawnJson->SetStringField(TEXT("class_path"), Pawn->GetClass()->GetPathName());
		PawnJson->SetStringField(TEXT("label"), ActorLabelOf(Pawn));
		PawnJson->SetStringField(TEXT("path"), Pawn->GetPathName());
		PawnJson->SetBoolField(TEXT("possessed"), bPossessed);
		Result->SetObjectField(TEXT("pawn"), PawnJson);
	}

	Result->SetBoolField(TEXT("possessed"), bPossessed);
	Result->SetBoolField(TEXT("ran"), bRan);
	Result->SetBoolField(TEXT("running"), bRunning);
	Result->SetBoolField(TEXT("started"), bStarted);
	Result->SetBoolField(TEXT("assignment_persisted"), false);
	Result->SetStringField(TEXT("brain_component"), BrainComponent ? BrainComponent->GetClass()->GetName() : FString());

	if (CurrentTree)
	{
		Result->SetObjectField(TEXT("current_tree"), MakeAssetReference(CurrentTree));
	}
	if (PreviousTree && PreviousTree != CurrentTree)
	{
		Result->SetObjectField(TEXT("previous_tree"), MakeAssetReference(PreviousTree));
	}

	if (!bStarted)
	{
		Result->SetBoolField(TEXT("success"), false);
		Result->SetStringField(TEXT("message"), bRan
			? FString::Printf(TEXT("RunBehaviorTree returned true but %s does not report %s as its current tree."), *Controller->GetName(), *BehaviorTree->GetName())
			: FString::Printf(TEXT("RunBehaviorTree failed for %s; check that the behavior tree has a valid blackboard and root node."), *Controller->GetName()));
	}

	if (WorldKind == TEXT("editor"))
	{
		Warnings.Add(TEXT("Behavior tree logic only ticks while the level is simulated or in Play In Editor; the tree is started on this editor-world controller instance only."));
	}
	if (UBlueprint* OwningBlueprint = Cast<UBlueprint>(Controller->GetClass()->ClassGeneratedBy))
	{
		Warnings.Add(FString::Printf(
			TEXT("The assignment is not persisted: %s only affects this placed or spawned controller instance. Set the default behavior tree on the %s Blueprint to persist it for every instance."),
			*BehaviorTree->GetName(),
			*OwningBlueprint->GetName()));
	}
	else
	{
		Warnings.Add(TEXT("The assignment is not persisted: it only affects this controller instance, not the controller class."));
	}

	SetWarnings(Result, Warnings);
	return UEVGraph::Serialize(Result);
}
