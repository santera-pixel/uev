#include "UEVGraphShared.h"

#include "AssetRegistryModule.h"
#include "Editor.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "HAL/PlatformMisc.h"
#include "Components/SceneComponent.h"
#include "Engine/SCS_Node.h"
#include "Engine/SimpleConstructionScript.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/CompilerResultsLog.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Misc/PackageName.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UObject/SavePackage.h"
#include "UObject/ScriptInterface.h"
#include "UObject/UnrealType.h"

namespace UEVGraph
{
	namespace
	{
		FString JsonValueString(const FJsonValuePtr& Value)
		{
			if (!Value.IsValid())
			{
				return FString();
			}
			if (Value->Type == EJson::String)
			{
				return Value->AsString();
			}
			if (Value->Type == EJson::Number)
			{
				return FString::SanitizeFloat(Value->AsNumber());
			}
			if (Value->Type == EJson::Boolean)
			{
				return Value->AsBool() ? TEXT("true") : TEXT("false");
			}
			return FString();
		}

		bool ResolveEnumValue(UEnum* Enum, const FJsonValuePtr& Value, int64& OutValue)
		{
			if (!Enum || !Value.IsValid())
			{
				return false;
			}
			if (Value->Type == EJson::Number)
			{
				OutValue = static_cast<int64>(Value->AsNumber());
				return true;
			}
			FString Text = Value->AsString();
			int32 ColonIndex = INDEX_NONE;
			if (Text.FindLastChar(TEXT(':'), ColonIndex))
			{
				Text = Text.RightChop(ColonIndex + 1);
			}
			OutValue = Enum->GetValueByName(FName(*Text));
			if (OutValue != INDEX_NONE)
			{
				return true;
			}
			for (int32 Index = 0; Index < Enum->NumEnums(); ++Index)
			{
				const FString EntryName = Enum->GetNameStringByIndex(Index);
				if (EntryName.Equals(Text, ESearchCase::IgnoreCase)
					|| EntryName.EndsWith(FString::Printf(TEXT("::%s"), *Text), ESearchCase::IgnoreCase))
				{
					OutValue = Enum->GetValueByIndex(Index);
					return true;
				}
			}
			return false;
		}

		bool SetMapKey(FProperty* KeyProperty, void* KeyPtr, const FString& KeyText, FString& OutError)
		{
			if (FStrProperty* StringProperty = CastField<FStrProperty>(KeyProperty))
			{
				StringProperty->SetPropertyValue(KeyPtr, KeyText);
				return true;
			}
			if (FNameProperty* NameProperty = CastField<FNameProperty>(KeyProperty))
			{
				NameProperty->SetPropertyValue(KeyPtr, FName(*KeyText));
				return true;
			}
			if (FIntProperty* IntProperty = CastField<FIntProperty>(KeyProperty))
			{
				IntProperty->SetPropertyValue(KeyPtr, FCString::Atoi(*KeyText));
				return true;
			}
			if (FInt64Property* Int64Property = CastField<FInt64Property>(KeyProperty))
			{
				Int64Property->SetPropertyValue(KeyPtr, FCString::Atoi64(*KeyText));
				return true;
			}
			if (FBoolProperty* BoolProperty = CastField<FBoolProperty>(KeyProperty))
			{
				BoolProperty->SetPropertyValue(KeyPtr, KeyText.ToBool());
				return true;
			}
			if (FByteProperty* ByteProperty = CastField<FByteProperty>(KeyProperty))
			{
				if (ByteProperty->Enum)
				{
					int64 EnumValue = INDEX_NONE;
					const FJsonValuePtr EnumJson = MakeShared<FJsonValueString>(KeyText);
					if (!ResolveEnumValue(ByteProperty->Enum, EnumJson, EnumValue))
					{
						OutError = FString::Printf(TEXT("Unknown map key enum value: %s"), *KeyText);
						return false;
					}
					ByteProperty->SetPropertyValue(KeyPtr, static_cast<uint8>(EnumValue));
				}
				else
				{
					ByteProperty->SetPropertyValue(KeyPtr, static_cast<uint8>(FCString::Atoi(*KeyText)));
				}
				return true;
			}
			if (FEnumProperty* EnumProperty = CastField<FEnumProperty>(KeyProperty))
			{
				int64 EnumValue = INDEX_NONE;
				const FJsonValuePtr EnumJson = MakeShared<FJsonValueString>(KeyText);
				if (!ResolveEnumValue(EnumProperty->GetEnum(), EnumJson, EnumValue))
				{
					OutError = FString::Printf(TEXT("Unknown map key enum value: %s"), *KeyText);
					return false;
				}
				EnumProperty->GetUnderlyingProperty()->SetIntPropertyValue(KeyPtr, EnumValue);
				return true;
			}
			if (KeyProperty && KeyProperty->ImportText(*KeyText, KeyPtr, PPF_None, nullptr))
			{
				return true;
			}
			OutError = FString::Printf(TEXT("Unsupported map key type for %s."), KeyProperty ? *KeyProperty->GetName() : TEXT("<null>"));
			return false;
		}

		bool SetValueDirect(FProperty* Property, void* ValuePtr, const FJsonValuePtr& Value, FString& OutError)
		{
			if (!Property || !ValuePtr || !Value.IsValid())
			{
				OutError = TEXT("Invalid property value.");
				return false;
			}

			if (FBoolProperty* BoolProperty = CastField<FBoolProperty>(Property))
			{
				BoolProperty->SetPropertyValue(ValuePtr, Value->AsBool());
				return true;
			}
			if (FFloatProperty* FloatProperty = CastField<FFloatProperty>(Property))
			{
				FloatProperty->SetPropertyValue(ValuePtr, static_cast<float>(Value->AsNumber()));
				return true;
			}
			if (FDoubleProperty* DoubleProperty = CastField<FDoubleProperty>(Property))
			{
				DoubleProperty->SetPropertyValue(ValuePtr, Value->AsNumber());
				return true;
			}
			if (FIntProperty* IntProperty = CastField<FIntProperty>(Property))
			{
				IntProperty->SetPropertyValue(ValuePtr, static_cast<int32>(Value->AsNumber()));
				return true;
			}
			if (FInt64Property* Int64Property = CastField<FInt64Property>(Property))
			{
				Int64Property->SetPropertyValue(ValuePtr, static_cast<int64>(Value->AsNumber()));
				return true;
			}
			if (FUInt32Property* UInt32Property = CastField<FUInt32Property>(Property))
			{
				UInt32Property->SetPropertyValue(ValuePtr, static_cast<uint32>(Value->AsNumber()));
				return true;
			}
			if (FStrProperty* StringProperty = CastField<FStrProperty>(Property))
			{
				StringProperty->SetPropertyValue(ValuePtr, Value->AsString());
				return true;
			}
			if (FNameProperty* NameProperty = CastField<FNameProperty>(Property))
			{
				NameProperty->SetPropertyValue(ValuePtr, FName(*Value->AsString()));
				return true;
			}
			if (FTextProperty* TextProperty = CastField<FTextProperty>(Property))
			{
				TextProperty->SetPropertyValue(ValuePtr, FText::FromString(Value->AsString()));
				return true;
			}
			if (FByteProperty* ByteProperty = CastField<FByteProperty>(Property))
			{
				if (ByteProperty->Enum && Value->Type == EJson::String)
				{
					int64 EnumValue = INDEX_NONE;
					if (!ResolveEnumValue(ByteProperty->Enum, Value, EnumValue))
					{
						OutError = FString::Printf(TEXT("Unknown enum value '%s' for %s."), *Value->AsString(), *Property->GetName());
						return false;
					}
					ByteProperty->SetPropertyValue(ValuePtr, static_cast<uint8>(EnumValue));
					return true;
				}
				ByteProperty->SetPropertyValue(ValuePtr, static_cast<uint8>(Value->AsNumber()));
				return true;
			}
			if (FEnumProperty* EnumProperty = CastField<FEnumProperty>(Property))
			{
				int64 EnumValue = INDEX_NONE;
				if (!ResolveEnumValue(EnumProperty->GetEnum(), Value, EnumValue))
				{
					OutError = FString::Printf(TEXT("Unknown enum value for %s."), *Property->GetName());
					return false;
				}
				EnumProperty->GetUnderlyingProperty()->SetIntPropertyValue(ValuePtr, EnumValue);
				return true;
			}
			if (FInterfaceProperty* InterfaceProperty = CastField<FInterfaceProperty>(Property))
			{
				const FString Path = JsonValueString(Value);
				UObject* Loaded = Path.IsEmpty() || Path.Equals(TEXT("None"), ESearchCase::IgnoreCase)
					? nullptr
					: LoadObject<UObject>(nullptr, *Path);
				if (!Path.IsEmpty() && !Loaded && !Path.Equals(TEXT("None"), ESearchCase::IgnoreCase))
				{
					OutError = FString::Printf(TEXT("Could not load object for %s: %s"), *Property->GetName(), *Path);
					return false;
				}
				FScriptInterface* InterfaceValue = static_cast<FScriptInterface*>(ValuePtr);
				InterfaceValue->SetObject(Loaded);
				return true;
			}
			if (FObjectPropertyBase* ObjectProperty = CastField<FObjectPropertyBase>(Property))
			{
				const FString Path = JsonValueString(Value);
				UObject* Loaded = Path.IsEmpty() || Path.Equals(TEXT("None"), ESearchCase::IgnoreCase)
					? nullptr
					: LoadObject<UObject>(nullptr, *Path);
				if (!Path.IsEmpty() && !Loaded && !Path.Equals(TEXT("None"), ESearchCase::IgnoreCase))
				{
					OutError = FString::Printf(TEXT("Could not load object for %s: %s"), *Property->GetName(), *Path);
					return false;
				}
				if (FClassProperty* ClassProperty = CastField<FClassProperty>(Property))
				{
					if (Loaded && !Loaded->IsA(UClass::StaticClass()))
					{
						OutError = FString::Printf(TEXT("%s requires a class path."), *Property->GetName());
						return false;
					}
					ClassProperty->SetObjectPropertyValue(ValuePtr, Loaded);
				}
				else
				{
					ObjectProperty->SetObjectPropertyValue(ValuePtr, Loaded);
				}
				return true;
			}
			if (FSoftObjectProperty* SoftObjectProperty = CastField<FSoftObjectProperty>(Property))
			{
				FSoftObjectPtr* SoftPtr = static_cast<FSoftObjectPtr*>(ValuePtr);
				*SoftPtr = FSoftObjectPtr(FSoftObjectPath(JsonValueString(Value)));
				return true;
			}
			if (FArrayProperty* ArrayProperty = CastField<FArrayProperty>(Property))
			{
				const TArray<TSharedPtr<FJsonValue>>* Values = nullptr;
				if (!Value->TryGetArray(Values))
				{
					OutError = FString::Printf(TEXT("%s requires an array."), *Property->GetName());
					return false;
				}
				FScriptArrayHelper Helper(ArrayProperty, ValuePtr);
				Helper.EmptyValues();
				Helper.AddValues(Values->Num());
				for (int32 Index = 0; Index < Values->Num(); ++Index)
				{
					FString InnerError;
					const bool bOk = SetValueDirect(ArrayProperty->Inner, Helper.GetRawPtr(Index), (*Values)[Index], InnerError);
					if (!bOk)
					{
						OutError = InnerError;
						return false;
					}
				}
				return true;
			}
			if (FMapProperty* MapProperty = CastField<FMapProperty>(Property))
			{
				const TSharedPtr<FJsonObject> Object = Value->AsObject();
				if (!Object.IsValid())
				{
					OutError = FString::Printf(TEXT("%s requires an object value."), *Property->GetName());
					return false;
				}
				FScriptMapHelper Helper(MapProperty, ValuePtr);
				Helper.EmptyValues();
				for (const auto& Pair : Object->Values)
				{
					const int32 Index = Helper.AddDefaultValue_Invalid_NeedsRehash();
					FString KeyError;
					if (!SetMapKey(MapProperty->KeyProp, Helper.GetKeyPtr(Index), Pair.Key, KeyError))
					{
						OutError = KeyError;
						return false;
					}
					FString ValueError;
					if (!SetValueDirect(MapProperty->ValueProp, Helper.GetValuePtr(Index), Pair.Value, ValueError))
					{
						OutError = ValueError;
						return false;
					}
				}
				Helper.Rehash();
				return true;
			}
			if (FSetProperty* SetProperty = CastField<FSetProperty>(Property))
			{
				const TArray<TSharedPtr<FJsonValue>>* Values = nullptr;
				if (!Value->TryGetArray(Values))
				{
					OutError = FString::Printf(TEXT("%s requires an array."), *Property->GetName());
					return false;
				}
				FScriptSetHelper Helper(SetProperty, ValuePtr);
				Helper.EmptyElements();
				for (const TSharedPtr<FJsonValue>& Entry : *Values)
				{
					const int32 Index = Helper.AddDefaultValue_Invalid_NeedsRehash();
					FString EntryError;
					if (!SetValueDirect(SetProperty->ElementProp, Helper.GetElementPtr(Index), Entry, EntryError))
					{
						OutError = EntryError;
						return false;
					}
				}
				Helper.Rehash();
				return true;
			}
			if (FStructProperty* StructProperty = CastField<FStructProperty>(Property))
			{
				const TSharedPtr<FJsonObject> Object = Value->AsObject();
				if (!Object.IsValid())
				{
					OutError = FString::Printf(TEXT("%s requires an object value."), *Property->GetName());
					return false;
				}
				for (const auto& Pair : Object->Values)
				{
					FProperty* Child = StructProperty->Struct->FindPropertyByName(FName(*Pair.Key));
					if (!Child)
					{
						OutError = FString::Printf(TEXT("Unknown struct field %s.%s."), *Property->GetName(), *Pair.Key);
						return false;
					}
					FString ChildError;
					if (!SetValueDirect(Child, Child->ContainerPtrToValuePtr<void>(ValuePtr), Pair.Value, ChildError))
					{
						OutError = ChildError;
						return false;
					}
				}
				return true;
			}

			OutError = FString::Printf(TEXT("Unsupported property type for %s."), *Property->GetName());
			return false;
		}
	}

	FJsonObjectPtr MakeObject()
	{
		return MakeShared<FJsonObject>();
	}

	FJsonObjectPtr MakeErrorObject(const FString& Message)
	{
		FJsonObjectPtr Result = MakeObject();
		Result->SetBoolField(TEXT("success"), false);
		Result->SetStringField(TEXT("message"), Message);
		return Result;
	}

	FJsonObjectPtr MakeSuccess()
	{
		FJsonObjectPtr Result = MakeObject();
		Result->SetBoolField(TEXT("success"), true);
		return Result;
	}

	bool IsPlayInEditorActive(int32& OutWorldCount)
	{
		OutWorldCount = 0;
		if (!GEditor)
		{
			return false;
		}
		for (const FWorldContext& Context : GEditor->GetWorldContexts())
		{
			if (Context.WorldType != EWorldType::PIE && Context.WorldType != EWorldType::Game)
			{
				continue;
			}
			if (Context.World() != nullptr)
			{
				++OutWorldCount;
			}
		}
		return OutWorldCount > 0;
	}

	bool UnsafeOperationsAllowed()
	{
		auto IsEnabled = [](const TCHAR* VariableName)
		{
			FString Value = FPlatformMisc::GetEnvironmentVariable(VariableName);
			Value.TrimStartAndEndInline();
			Value.ToLowerInline();
			return Value == TEXT("1") || Value == TEXT("true") || Value == TEXT("yes") || Value == TEXT("on");
		};
		return IsEnabled(TEXT("UEV_ALLOW_UNSAFE_OPERATIONS"));
	}

	FJsonObjectPtr MakeGuardRefusal(
		const FString& GuardId,
		const FString& GuardTitle,
		const FString& Message,
		const FString& Hint)
	{
		FJsonObjectPtr Result = MakeObject();
		Result->SetBoolField(TEXT("success"), false);
		Result->SetStringField(TEXT("message"), Message);

		FJsonObjectPtr Error = MakeObject();
		Error->SetStringField(TEXT("code"), TEXT("unsafe_operation_refused"));
		Error->SetStringField(TEXT("guard"), GuardId);
		Error->SetStringField(TEXT("message"), Message);
		Error->SetStringField(TEXT("hint"), Hint);
		Result->SetObjectField(TEXT("error"), Error.ToSharedRef());

		FJsonObjectPtr Guard = MakeObject();
		Guard->SetStringField(TEXT("id"), GuardId);
		Guard->SetStringField(TEXT("title"), GuardTitle);
		Guard->SetStringField(TEXT("behaviour"), TEXT("refuse"));
		Result->SetObjectField(TEXT("guard"), Guard.ToSharedRef());

		return Result;
	}

	FString Serialize(const FJsonObjectPtr& Object)
	{
		FString Output;
		const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
		FJsonSerializer::Serialize(Object.ToSharedRef(), Writer);
		return Output;
	}

	FString GetString(const FJsonObject& Object, const FString& Field, const FString& Default)
	{
		FString Value;
		return Object.TryGetStringField(Field, Value) ? Value : Default;
	}

	bool GetBool(const FJsonObject& Object, const FString& Field, bool bDefault)
	{
		bool bValue = bDefault;
		return Object.TryGetBoolField(Field, bValue) ? bValue : bDefault;
	}

	double GetNumber(const FJsonObject& Object, const FString& Field, double Default)
	{
		double Value = Default;
		return Object.TryGetNumberField(Field, Value) ? Value : Default;
	}

	FJsonObjectPtr GetObject(const FJsonObject& Object, const FString& Field)
	{
		const TSharedPtr<FJsonObject>* Value = nullptr;
		return Object.TryGetObjectField(Field, Value) && Value ? *Value : nullptr;
	}

	const TArray<TSharedPtr<FJsonValue>>* GetArray(const FJsonObject& Object, const FString& Field)
	{
		const TArray<TSharedPtr<FJsonValue>>* Value = nullptr;
		return Object.TryGetArrayField(Field, Value) ? Value : nullptr;
	}

	FString AssetIdentifier(const FJsonObject& Args)
	{
		for (const TCHAR* Field : {
			TEXT("asset_path"), TEXT("anim_blueprint"), TEXT("blueprint_name"), TEXT("material_path"),
			TEXT("function_path"), TEXT("sequence_path"), TEXT("montage_path"), TEXT("source_asset_path"),
			TEXT("path"), TEXT("name")
		})
		{
			FString Value;
			if (Args.TryGetStringField(Field, Value) && !Value.IsEmpty())
			{
				return Value;
			}
		}
		return FString();
	}

	UObject* LoadAsset(const FString& Identifier, UClass* ExpectedClass, FString& OutError)
	{
		if (Identifier.IsEmpty())
		{
			OutError = TEXT("An asset path or name is required.");
			return nullptr;
		}

		UObject* Loaded = nullptr;
		if (Identifier.Contains(TEXT("/")))
		{
			Loaded = LoadObject<UObject>(nullptr, *Identifier);
		}
		if (!Loaded)
		{
			FAssetRegistryModule& RegistryModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry");
			TArray<FAssetData> Assets;
			RegistryModule.Get().GetAssetsByClass(ExpectedClass ? ExpectedClass->GetFName() : UObject::StaticClass()->GetFName(), Assets, true);
			for (const FAssetData& Asset : Assets)
			{
				if (Asset.AssetName.ToString().Equals(Identifier, ESearchCase::IgnoreCase)
					|| Asset.PackageName.ToString().Equals(Identifier, ESearchCase::IgnoreCase))
				{
					Loaded = Asset.GetAsset();
					break;
				}
			}
		}

		if (!Loaded)
		{
			OutError = FString::Printf(TEXT("Asset not found: %s"), *Identifier);
			return nullptr;
		}
		if (ExpectedClass && !Loaded->IsA(ExpectedClass))
		{
			OutError = FString::Printf(TEXT("Asset %s is not a %s."), *Identifier, *ExpectedClass->GetName());
			return nullptr;
		}
		return Loaded;
	}

	UClass* ResolveClass(const FString& ClassName, UClass* ExpectedBase, FString& OutError)
	{
		if (ClassName.IsEmpty())
		{
			OutError = TEXT("A class name is required.");
			return nullptr;
		}

		UClass* Resolved = nullptr;
		if (ClassName.Contains(TEXT("/")))
		{
			Resolved = LoadObject<UClass>(nullptr, *ClassName);
		}
		if (!Resolved)
		{
			Resolved = FindObject<UClass>(ANY_PACKAGE, *ClassName);
		}
		if (!Resolved)
		{
			Resolved = LoadObject<UClass>(nullptr, *FString::Printf(TEXT("/Script/Engine.%s"), *ClassName));
		}
		if (!Resolved)
		{
			Resolved = LoadObject<UClass>(nullptr, *FString::Printf(TEXT("/Script/BlueprintGraph.%s"), *ClassName));
		}
		if (!Resolved)
		{
			OutError = FString::Printf(TEXT("Class not found: %s"), *ClassName);
			return nullptr;
		}
		if (ExpectedBase && !Resolved->IsChildOf(ExpectedBase))
		{
			OutError = FString::Printf(TEXT("Class %s is not a %s."), *ClassName, *ExpectedBase->GetName());
			return nullptr;
		}
		return Resolved;
	}

	UBlueprint* LoadBlueprint(const FJsonObject& Args, FString& OutError)
	{
		FString Identifier = GetString(Args, TEXT("asset_path"));
		if (Identifier.IsEmpty()) Identifier = GetString(Args, TEXT("blueprint_name"));
		if (Identifier.IsEmpty()) Identifier = GetString(Args, TEXT("name"));
		return Cast<UBlueprint>(LoadAsset(Identifier, UBlueprint::StaticClass(), OutError));
	}

	UAnimBlueprint* LoadAnimBlueprint(const FJsonObject& Args, FString& OutError)
	{
		FString Identifier = GetString(Args, TEXT("asset_path"));
		if (Identifier.IsEmpty()) Identifier = GetString(Args, TEXT("anim_blueprint"));
		if (Identifier.IsEmpty()) Identifier = GetString(Args, TEXT("blueprint_name"));
		if (Identifier.IsEmpty()) Identifier = GetString(Args, TEXT("name"));
		return Cast<UAnimBlueprint>(LoadAsset(Identifier, UAnimBlueprint::StaticClass(), OutError));
	}

	UMaterial* LoadMaterial(const FJsonObject& Args, FString& OutError)
	{
		FString Identifier = GetString(Args, TEXT("asset_path"));
		if (Identifier.IsEmpty()) Identifier = GetString(Args, TEXT("material_path"));
		if (Identifier.IsEmpty()) Identifier = GetString(Args, TEXT("name"));
		return Cast<UMaterial>(LoadAsset(Identifier, UMaterial::StaticClass(), OutError));
	}

	UMaterialFunction* LoadMaterialFunction(const FJsonObject& Args, FString& OutError)
	{
		FString Identifier = GetString(Args, TEXT("asset_path"));
		if (Identifier.IsEmpty()) Identifier = GetString(Args, TEXT("function_path"));
		if (Identifier.IsEmpty()) Identifier = GetString(Args, TEXT("name"));
		return Cast<UMaterialFunction>(LoadAsset(Identifier, UMaterialFunction::StaticClass(), OutError));
	}

	UAnimSequence* LoadAnimSequence(const FJsonObject& Args, FString& OutError)
	{
		FString Identifier = GetString(Args, TEXT("sequence_path"));
		if (Identifier.IsEmpty()) Identifier = GetString(Args, TEXT("source_sequence"));
		if (Identifier.IsEmpty()) Identifier = GetString(Args, TEXT("asset_path"));
		if (Identifier.IsEmpty()) Identifier = GetString(Args, TEXT("name"));
		return Cast<UAnimSequence>(LoadAsset(Identifier, UAnimSequence::StaticClass(), OutError));
	}

	UAnimMontage* LoadAnimMontage(const FJsonObject& Args, FString& OutError)
	{
		FString Identifier = GetString(Args, TEXT("montage_path"));
		if (Identifier.IsEmpty()) Identifier = GetString(Args, TEXT("asset_path"));
		if (Identifier.IsEmpty()) Identifier = GetString(Args, TEXT("name"));
		return Cast<UAnimMontage>(LoadAsset(Identifier, UAnimMontage::StaticClass(), OutError));
	}

	void AppendGraphs(UBlueprint* Blueprint, TArray<UEdGraph*>& OutGraphs, bool bIncludeSubGraphs)
	{
		if (!Blueprint)
		{
			return;
		}

		TArray<UEdGraph*> Roots;
		Roots.Append(Blueprint->UbergraphPages);
		Roots.Append(Blueprint->FunctionGraphs);
		Roots.Append(Blueprint->MacroGraphs);
		Roots.Append(Blueprint->DelegateSignatureGraphs);

		TFunction<void(UEdGraph*)> AddGraph = [&](UEdGraph* Graph)
		{
			if (!Graph || OutGraphs.Contains(Graph))
			{
				return;
			}
			OutGraphs.Add(Graph);
			if (bIncludeSubGraphs)
			{
				for (UEdGraph* Child : Graph->SubGraphs)
				{
					AddGraph(Child);
				}
			}
		};
		for (UEdGraph* Graph : Roots)
		{
			AddGraph(Graph);
		}
	}

	UEdGraph* FindGraphByName(UBlueprint* Blueprint, const FString& GraphName)
	{
		if (!Blueprint || GraphName.IsEmpty())
		{
			return nullptr;
		}
		TArray<UEdGraph*> Graphs;
		AppendGraphs(Blueprint, Graphs, true);
		for (UEdGraph* Graph : Graphs)
		{
			if (Graph && (Graph->GetName().Equals(GraphName, ESearchCase::IgnoreCase)
				|| Graph->GetFName().ToString().Equals(GraphName, ESearchCase::IgnoreCase)))
			{
				return Graph;
			}
		}
		return nullptr;
	}

	UEdGraph* ResolveGraph(UBlueprint* Blueprint, const FString& GraphName, FString& OutError)
	{
		if (!Blueprint)
		{
			OutError = TEXT("Blueprint is required.");
			return nullptr;
		}

		const FString Normalized = GraphName.TrimStartAndEnd().ToLower();
		UEdGraph* Graph = nullptr;
		if (Normalized.IsEmpty() || Normalized == TEXT("event") || Normalized == TEXT("eventgraph"))
		{
			Graph = FBlueprintEditorUtils::FindEventGraph(Blueprint);
		}
		else if (Normalized == TEXT("construction") || Normalized == TEXT("userconstructionscript"))
		{
			Graph = FBlueprintEditorUtils::FindUserConstructionScript(Blueprint);
		}
		else if (Normalized == TEXT("anim") || Normalized == TEXT("animgraph"))
		{
			Graph = FindGraphByName(Blueprint, TEXT("AnimGraph"));
		}
		else
		{
			Graph = FindGraphByName(Blueprint, GraphName);
		}

		if (!Graph)
		{
			OutError = FString::Printf(TEXT("Graph not found: %s"), *GraphName);
		}
		return Graph;
	}

	FString NodeId(UEdGraphNode* Node)
	{
		return Node ? Node->NodeGuid.ToString(EGuidFormats::DigitsWithHyphens) : FString();
	}

	FString PinName(UEdGraphPin* Pin)
	{
		return Pin ? Pin->PinName.ToString() : FString();
	}

	FString PinTypeName(const FEdGraphPinType& Type)
	{
		FString Result = Type.PinCategory.ToString();
		if (!Type.PinSubCategory.IsNone())
		{
			Result += FString::Printf(TEXT(":%s"), *Type.PinSubCategory.ToString());
		}
		if (Type.PinSubCategoryObject.IsValid())
		{
			Result += FString::Printf(TEXT(":%s"), *Type.PinSubCategoryObject->GetName());
		}
		if (Type.IsArray())
		{
			Result = FString::Printf(TEXT("array:%s"), *Result);
		}
		return Result;
	}

	UEdGraphNode* FindNodeInGraph(UEdGraph* Graph, const FString& NodeIdValue)
	{
		if (!Graph || NodeIdValue.IsEmpty())
		{
			return nullptr;
		}
		for (UEdGraphNode* Node : Graph->Nodes)
		{
			if (Node && (NodeId(Node).Equals(NodeIdValue, ESearchCase::IgnoreCase)
				|| Node->GetName().Equals(NodeIdValue, ESearchCase::IgnoreCase)))
			{
				return Node;
			}
		}
		return nullptr;
	}

	UEdGraphNode* FindNode(UBlueprint* Blueprint, const FString& NodeIdValue, UEdGraph** OutGraph)
	{
		if (!Blueprint || NodeIdValue.IsEmpty())
		{
			return nullptr;
		}
		TArray<UEdGraph*> Graphs;
		AppendGraphs(Blueprint, Graphs, true);
		for (UEdGraph* Graph : Graphs)
		{
			if (UEdGraphNode* Node = FindNodeInGraph(Graph, NodeIdValue))
			{
				if (OutGraph)
				{
					*OutGraph = Graph;
				}
				return Node;
			}
		}
		return nullptr;
	}

	UEdGraph* ResolveOptionalGraph(UBlueprint* Blueprint, const FJsonObject& Args, bool& bOutNamed, FString& OutError)
	{
		bOutNamed = false;
		const FString GraphName = GetString(Args, TEXT("graph_name"), GetString(Args, TEXT("graph"))).TrimStartAndEnd();
		const FString GraphIdValue = GetString(Args, TEXT("graph_id")).TrimStartAndEnd();
		if (GraphName.IsEmpty() && GraphIdValue.IsEmpty())
		{
			return nullptr;
		}
		// Mark the graph as named before resolving: callers treat (named && !Graph) as an
		// error, so a bogus graph_name/graph_id must not silently fall back to a whole-blueprint scan.
		bOutNamed = true;
		return ResolveGraphArg(Blueprint, Args, bOutNamed, OutError);
	}

	UEdGraphPin* FindPin(UEdGraphNode* Node, const FString& PinNameValue)
	{
		if (!Node || PinNameValue.IsEmpty())
		{
			return nullptr;
		}
		for (UEdGraphPin* Pin : Node->Pins)
		{
			if (Pin && Pin->PinName.ToString().Equals(PinNameValue, ESearchCase::IgnoreCase))
			{
				return Pin;
			}
		}
		return nullptr;
	}

	FJsonObjectPtr SerializeNode(UEdGraphNode* Node, UEdGraph* Graph)
	{
		FJsonObjectPtr Result = MakeObject();
		if (!Node)
		{
			return Result;
		}
		Result->SetStringField(TEXT("id"), NodeId(Node));
		Result->SetStringField(TEXT("name"), Node->GetName());
		Result->SetStringField(TEXT("class"), Node->GetClass()->GetName());
		Result->SetStringField(TEXT("title"), Node->GetNodeTitle(ENodeTitleType::FullTitle).ToString());
		Result->SetStringField(TEXT("graph"), Graph ? Graph->GetName() : FString());
		Result->SetNumberField(TEXT("x"), Node->NodePosX);
		Result->SetNumberField(TEXT("y"), Node->NodePosY);

		TArray<TSharedPtr<FJsonValue>> Pins;
		for (UEdGraphPin* Pin : Node->Pins)
		{
			if (!Pin)
			{
				continue;
			}
			FJsonObjectPtr PinObject = MakeObject();
			PinObject->SetStringField(TEXT("name"), Pin->PinName.ToString());
			PinObject->SetStringField(TEXT("direction"), Pin->Direction == EGPD_Output ? TEXT("output") : TEXT("input"));
			PinObject->SetStringField(TEXT("type"), PinTypeName(Pin->PinType));
			PinObject->SetStringField(TEXT("default"), Pin->DefaultValue);
			if (Pin->DefaultObject)
			{
				PinObject->SetStringField(TEXT("default_object"), Pin->DefaultObject->GetPathName());
			}
			TArray<TSharedPtr<FJsonValue>> Links;
			for (UEdGraphPin* LinkedPin : Pin->LinkedTo)
			{
				if (!LinkedPin)
				{
					continue;
				}
				FJsonObjectPtr LinkObject = MakeObject();
				LinkObject->SetStringField(TEXT("node_id"), NodeId(LinkedPin->GetOwningNode()));
				LinkObject->SetStringField(TEXT("pin"), LinkedPin->PinName.ToString());
				Links.Add(MakeShared<FJsonValueObject>(LinkObject));
			}
			PinObject->SetArrayField(TEXT("linked_to"), Links);
			Pins.Add(MakeShared<FJsonValueObject>(PinObject));
		}
		Result->SetArrayField(TEXT("pins"), Pins);
		return Result;
	}

	FJsonObjectPtr SerializeGraph(UEdGraph* Graph, bool bIncludeNodes)
	{
		FJsonObjectPtr Result = MakeObject();
		if (!Graph)
		{
			return Result;
		}
		Result->SetStringField(TEXT("graph_id"), GraphId(Graph));
		Result->SetStringField(TEXT("name"), Graph->GetName());
		Result->SetStringField(TEXT("class"), Graph->GetClass()->GetName());
		Result->SetStringField(TEXT("kind"), GraphKind(Graph));
		if (UBlueprint* Owner = FindOwningBlueprint(Graph))
		{
			Result->SetStringField(TEXT("owner"), Owner->GetPathName());
		}
		if (UEdGraph* Parent = FindParentGraph(Graph))
		{
			Result->SetStringField(TEXT("parent_graph_id"), GraphId(Parent));
		}
		Result->SetStringField(TEXT("schema"), Graph->Schema ? Graph->Schema->GetName() : FString());
		Result->SetNumberField(TEXT("node_count"), Graph->Nodes.Num());
		if (bIncludeNodes)
		{
			TArray<TSharedPtr<FJsonValue>> Nodes;
			for (UEdGraphNode* Node : Graph->Nodes)
			{
				Nodes.Add(MakeShared<FJsonValueObject>(SerializeNode(Node, Graph)));
			}
			Result->SetArrayField(TEXT("nodes"), Nodes);
		}
		return Result;
	}

	bool ConnectPins(UEdGraphPin* SourcePin, UEdGraphPin* TargetPin, FString& OutError)
	{
		if (!SourcePin || !TargetPin)
		{
			OutError = TEXT("Both source and target pins are required.");
			return false;
		}
		UEdGraph* Graph = SourcePin->GetOwningNode() ? SourcePin->GetOwningNode()->GetGraph() : nullptr;
		const UEdGraphSchema* Schema = Graph ? Graph->GetSchema() : nullptr;
		if (!Schema || !Schema->TryCreateConnection(SourcePin, TargetPin))
		{
			OutError = TEXT("The graph schema rejected this pin connection.");
			return false;
		}
		if (SourcePin->GetOwningNode())
		{
			SourcePin->GetOwningNode()->NodeConnectionListChanged();
		}
		if (TargetPin->GetOwningNode())
		{
			TargetPin->GetOwningNode()->NodeConnectionListChanged();
		}
		return true;
	}

	int32 DisconnectPins(UEdGraphPin* SourcePin, UEdGraphPin* TargetPin, FString& OutError)
	{
		if (!SourcePin)
		{
			OutError = TEXT("Source pin is required.");
			return 0;
		}
		UEdGraph* Graph = SourcePin->GetOwningNode() ? SourcePin->GetOwningNode()->GetGraph() : nullptr;
		const UEdGraphSchema* Schema = Graph ? Graph->GetSchema() : nullptr;
		if (!Schema)
		{
			OutError = TEXT("Graph schema is unavailable.");
			return 0;
		}
		const int32 Count = TargetPin ? 1 : SourcePin->LinkedTo.Num();
		if (TargetPin)
		{
			Schema->BreakSinglePinLink(SourcePin, TargetPin);
		}
		else
		{
			Schema->BreakPinLinks(*SourcePin, true);
		}
		return Count;
	}

	bool SetPinDefault(UEdGraphPin* Pin, const FJsonValuePtr& Value, FString& OutError)
	{
		if (!Pin || !Value.IsValid())
		{
			OutError = TEXT("Pin and value are required.");
			return false;
		}
		if (Value->Type == EJson::String)
		{
			const FString Text = Value->AsString();
			if (Text.StartsWith(TEXT("/")))
			{
				UObject* Loaded = LoadObject<UObject>(nullptr, *Text);
				if (!Loaded)
				{
					OutError = FString::Printf(TEXT("Could not load object: %s"), *Text);
					return false;
				}
				Pin->DefaultObject = Loaded;
				Pin->DefaultValue.Empty();
				return true;
			}
			Pin->DefaultValue = Text;
			Pin->DefaultObject = nullptr;
			return true;
		}
		if (Value->Type == EJson::Boolean)
		{
			Pin->DefaultValue = Value->AsBool() ? TEXT("true") : TEXT("false");
			return true;
		}
		if (Value->Type == EJson::Number)
		{
			Pin->DefaultValue = FString::SanitizeFloat(Value->AsNumber());
			return true;
		}
		OutError = TEXT("Unsupported pin default value.");
		return false;
	}

	bool SetObjectPropertyPath(UObject* Object, const FString& PropertyPath, const FJsonValuePtr& Value, FString& OutError)
	{
		if (!Object || PropertyPath.IsEmpty() || !Value.IsValid())
		{
			OutError = TEXT("Object, property path, and value are required.");
			return false;
		}

		TArray<FString> Segments;
		PropertyPath.ParseIntoArray(Segments, TEXT("."), true);
		if (Segments.Num() == 0)
		{
			OutError = TEXT("Property path is empty.");
			return false;
		}

		void* Container = Object;
		UStruct* Struct = Object->GetClass();
		for (int32 Index = 0; Index < Segments.Num(); ++Index)
		{
			FProperty* Property = Struct ? Struct->FindPropertyByName(FName(*Segments[Index])) : nullptr;
			if (!Property)
			{
				// Accept snake_case and UE-prefixed spellings: the documented
				// "parameter_name" should reach ParameterName, and
				// "simulate_physics" should reach bSimulatePhysics.
				FString Wanted = Segments[Index].Replace(TEXT("_"), TEXT("")).ToLower();
				if (Struct)
				{
					for (TFieldIterator<FProperty> It(Struct); It; ++It)
					{
						FProperty* Candidate = *It;
						if (!Candidate)
						{
							continue;
						}
						FString CandidateName = Candidate->GetName();
						FString CandidateCompact = CandidateName.Replace(TEXT("_"), TEXT("")).ToLower();
						const bool bPrefixMatch = CandidateCompact == Wanted
							|| CandidateCompact == FString(TEXT("b")) + Wanted
							|| (!Wanted.IsEmpty() && Wanted[0] == TEXT('b') && CandidateCompact == Wanted.RightChop(1));
						if (bPrefixMatch)
						{
							Property = Candidate;
							break;
						}
					}
				}
			}
			if (!Property)
			{
				FString Available;
				int32 Listed = 0;
				if (Struct)
				{
					for (TFieldIterator<FProperty> It(Struct); It && Listed < 24; ++It)
					{
						if (!*It)
						{
							continue;
						}
						if (!Available.IsEmpty())
						{
							Available += TEXT(", ");
						}
						Available += (*It)->GetName();
						++Listed;
					}
				}
				OutError = Available.IsEmpty()
					? FString::Printf(TEXT("Property not found: %s"), *Segments[Index])
					: FString::Printf(TEXT("Property not found: %s. Available properties include: %s"), *Segments[Index], *Available);
				return false;
			}

			const bool bLast = Index == Segments.Num() - 1;
			if (FStructProperty* StructProperty = CastField<FStructProperty>(Property))
			{
				void* StructValue = Property->ContainerPtrToValuePtr<void>(Container);
				if (bLast)
				{
					return SetValueDirect(Property, StructValue, Value, OutError);
				}
				Container = StructValue;
				Struct = StructProperty->Struct;
				continue;
			}
			if (!bLast)
			{
				OutError = FString::Printf(TEXT("Cannot descend through non-struct property: %s"), *Segments[Index]);
				return false;
			}

			return SetValueDirect(Property, Property->ContainerPtrToValuePtr<void>(Container), Value, OutError);
		}

		OutError = TEXT("Property path could not be resolved.");
		return false;
	}

	bool SaveAsset(UObject* Asset, FString& OutError)
	{
		if (!Asset)
		{
			OutError = TEXT("Asset is required.");
			return false;
		}
		UPackage* Package = Asset->GetOutermost();
		if (!Package || !Package->GetName().StartsWith(TEXT("/Game/")))
		{
			OutError = TEXT("Only /Game/ assets can be saved.");
			return false;
		}
		Package->MarkPackageDirty();
		const FString Filename = FPackageName::LongPackageNameToFilename(
			Package->GetName(),
			FPackageName::GetAssetPackageExtension());
		if (!UPackage::SavePackage(
			Package,
			Asset,
			RF_Public | RF_Standalone,
			*Filename,
			GError,
			nullptr,
			false,
			true,
			SAVE_NoError))
		{
			OutError = FString::Printf(TEXT("Failed to save %s."), *Package->GetName());
			return false;
		}
		return true;
	}

	FJsonObjectPtr FinalizeAssetEdit(UObject* Asset, const FJsonObject& Args, FJsonObjectPtr Result)
	{
		if (!Result.IsValid() || !Asset)
		{
			return Result;
		}
		if (!GetBool(Args, TEXT("save"), true))
		{
			Result->SetBoolField(TEXT("saved"), false);
			Result->SetBoolField(TEXT("dirty"), Asset->GetOutermost() && Asset->GetOutermost()->IsDirty());
			return Result;
		}
		FString Error;
		if (!SaveAsset(Asset, Error))
		{
			Result->SetBoolField(TEXT("success"), false);
			Result->SetBoolField(TEXT("saved"), false);
			Result->SetBoolField(TEXT("dirty"), Asset->GetOutermost() && Asset->GetOutermost()->IsDirty());
			Result->SetStringField(TEXT("message"), Error);
			Result->SetStringField(TEXT("save_error"), Error);
			return Result;
		}
		Result->SetBoolField(TEXT("saved"), true);
		Result->SetBoolField(TEXT("dirty"), false);
		return Result;
	}

	bool CompileBlueprint(UBlueprint* Blueprint, FJsonObjectPtr& OutResult)
	{
		if (!Blueprint)
		{
			OutResult = MakeErrorObject(TEXT("Blueprint is required."));
			return false;
		}
		FCompilerResultsLog Results;
		FKismetEditorUtilities::CompileBlueprint(Blueprint, EBlueprintCompileOptions::None, &Results);
		OutResult = MakeObject();
		OutResult->SetBoolField(TEXT("success"), Results.NumErrors == 0);
		OutResult->SetNumberField(TEXT("errors"), Results.NumErrors);
		OutResult->SetNumberField(TEXT("warnings"), Results.NumWarnings);
		OutResult->SetStringField(TEXT("asset_path"), Blueprint->GetPathName());
		return Results.NumErrors == 0;
	}

	USCS_Node* FindComponentNode(UBlueprint* Blueprint, const FString& ComponentName)
	{
		if (!Blueprint || !Blueprint->SimpleConstructionScript)
		{
			return nullptr;
		}
		for (USCS_Node* Node : Blueprint->SimpleConstructionScript->GetAllNodes())
		{
			if (!Node)
			{
				continue;
			}
			if (Node->GetVariableName().ToString().Equals(ComponentName, ESearchCase::IgnoreCase)
				|| Node->GetName().Equals(ComponentName, ESearchCase::IgnoreCase)
				|| (Node->ComponentTemplate && Node->ComponentTemplate->GetName().Equals(ComponentName, ESearchCase::IgnoreCase)))
			{
				return Node;
			}
		}
		return nullptr;
	}

	UClass* ResolveFunctionOwner(UBlueprint* Blueprint, const FString& Target, FString& OutError)
	{
		if (!Blueprint)
		{
			OutError = TEXT("Blueprint is required.");
			return nullptr;
		}
		const FString Normalized = Target.TrimStartAndEnd();
		if (Normalized.IsEmpty() || Normalized.Equals(TEXT("self"), ESearchCase::IgnoreCase))
		{
			return Blueprint->ParentClass ? Blueprint->ParentClass : UObject::StaticClass();
		}
		if (Normalized.StartsWith(TEXT("component:"), ESearchCase::IgnoreCase))
		{
			const FString ComponentName = Normalized.RightChop(10);
			USCS_Node* Node = FindComponentNode(Blueprint, ComponentName);
			if (Node && Node->ComponentTemplate)
			{
				return Node->ComponentTemplate->GetClass();
			}
			if (Blueprint->GeneratedClass)
			{
				FProperty* Property = Blueprint->GeneratedClass->FindPropertyByName(FName(*ComponentName));
				if (FObjectPropertyBase* ObjectProperty = CastField<FObjectPropertyBase>(Property))
				{
					if (UClass* PropertyClass = ObjectProperty->PropertyClass)
					{
						return PropertyClass;
					}
				}
			}
			return USceneComponent::StaticClass();
		}
		if (Normalized.StartsWith(TEXT("class:"), ESearchCase::IgnoreCase))
		{
			return ResolveClass(Normalized.RightChop(6), UObject::StaticClass(), OutError);
		}
		if (Normalized.StartsWith(TEXT("/")))
		{
			return ResolveClass(Normalized, UObject::StaticClass(), OutError);
		}

		// Accept a bare class name such as "KismetSystemLibrary" or "Actor".
		// This matches the class: form above but is friendlier to hand-written
		// JSON, where forgetting the prefix previously produced a dead end.
		FString ClassError;
		if (UClass* BareClass = ResolveClass(Normalized, UObject::StaticClass(), ClassError))
		{
			return BareClass;
		}
		OutError = FString::Printf(
			TEXT("Unsupported function target: %s. Use \"self\", \"component:<Name>\", \"class:<ClassName>\", or a /Script path."),
			*Target);
		return nullptr;
	}

	UFunction* FindFunction(UClass* OwnerClass, const FString& FunctionName)
	{
		if (!OwnerClass)
		{
			return nullptr;
		}
		if (UFunction* Direct = OwnerClass->FindFunctionByName(FName(*FunctionName)))
		{
			return Direct;
		}
		for (TFieldIterator<UFunction> It(OwnerClass); It; ++It)
		{
			UFunction* Function = *It;
			if (Function && Function->GetMetaData(TEXT("ScriptName")).Equals(FunctionName, ESearchCase::IgnoreCase))
			{
				return Function;
			}
		}
		return nullptr;
	}

	FString ComponentClassPath(UBlueprint* Blueprint, const FString& ComponentName)
	{
		USCS_Node* Node = FindComponentNode(Blueprint, ComponentName);
		return Node && Node->ComponentTemplate ? Node->ComponentTemplate->GetClass()->GetPathName() : FString();
	}

	FString GraphId(UEdGraph* Graph)
	{
		if (!Graph)
		{
			return FString();
		}
#if WITH_EDITORONLY_DATA
		if (Graph->GraphGuid.IsValid())
		{
			return Graph->GraphGuid.ToString(EGuidFormats::DigitsWithHyphens);
		}
#endif
		return FString::Printf(TEXT("name:%s"), *Graph->GetName());
	}

	UBlueprint* FindOwningBlueprint(UEdGraph* Graph)
	{
		UObject* Outer = Graph ? Graph->GetOuter() : nullptr;
		while (Outer)
		{
			if (UBlueprint* Blueprint = Cast<UBlueprint>(Outer))
			{
				return Blueprint;
			}
			if (UEdGraph* ParentGraph = Cast<UEdGraph>(Outer))
			{
				if (UBlueprint* FromParent = FindOwningBlueprint(ParentGraph))
				{
					return FromParent;
				}
				Outer = ParentGraph->GetOuter();
				continue;
			}
			Outer = Outer->GetOuter();
		}
		return nullptr;
	}

	UEdGraph* FindParentGraph(UEdGraph* Graph)
	{
		UBlueprint* Blueprint = FindOwningBlueprint(Graph);
		if (!Blueprint || !Graph)
		{
			return nullptr;
		}
		TArray<UEdGraph*> All;
		AppendGraphs(Blueprint, All, true);
		for (UEdGraph* Candidate : All)
		{
			if (Candidate && Candidate != Graph && Candidate->SubGraphs.Contains(Graph))
			{
				return Candidate;
			}
		}
		return nullptr;
	}

	FString GraphKind(UEdGraph* Graph)
	{
		if (!Graph)
		{
			return TEXT("unknown");
		}
		UBlueprint* Blueprint = FindOwningBlueprint(Graph);
		if (!Blueprint)
		{
			return TEXT("unknown");
		}
		if (Cast<UAnimBlueprint>(Blueprint) && Graph->GetName().Equals(TEXT("AnimGraph"), ESearchCase::IgnoreCase))
		{
			return TEXT("anim");
		}
		if (Blueprint->UbergraphPages.Contains(Graph))
		{
			return TEXT("ubergraph");
		}
		if (Blueprint->FunctionGraphs.Contains(Graph))
		{
			return TEXT("function");
		}
		if (Blueprint->MacroGraphs.Contains(Graph))
		{
			return TEXT("macro");
		}
		if (Blueprint->DelegateSignatureGraphs.Contains(Graph))
		{
			return TEXT("delegate");
		}
		return TEXT("subgraph");
	}

	UEdGraph* FindGraphById(UBlueprint* Blueprint, const FString& InGraphId)
	{
		if (!Blueprint || InGraphId.IsEmpty())
		{
			return nullptr;
		}
		TArray<UEdGraph*> Graphs;
		AppendGraphs(Blueprint, Graphs, true);
		const FString Normalized = InGraphId.TrimStartAndEnd();
		for (UEdGraph* Graph : Graphs)
		{
			if (!Graph)
			{
				continue;
			}
#if WITH_EDITORONLY_DATA
			if (Graph->GraphGuid.IsValid())
			{
				if (Graph->GraphGuid.ToString(EGuidFormats::DigitsWithHyphens).Equals(Normalized, ESearchCase::IgnoreCase)
					|| Graph->GraphGuid.ToString(EGuidFormats::Digits).Equals(Normalized, ESearchCase::IgnoreCase))
				{
					return Graph;
				}
			}
#endif
			if (FString::Printf(TEXT("name:%s"), *Graph->GetName()).Equals(Normalized, ESearchCase::IgnoreCase))
			{
				return Graph;
			}
		}
		return nullptr;
	}

	UEdGraph* ResolveGraphArg(UBlueprint* Blueprint, const FJsonObject& Args, bool& bOutNamed, FString& OutError)
	{
		bOutNamed = false;
		if (!Blueprint)
		{
			OutError = TEXT("Blueprint is required.");
			return nullptr;
		}
		const FString GraphIdValue = GetString(Args, TEXT("graph_id"));
		if (!GraphIdValue.IsEmpty())
		{
			bOutNamed = true;
			UEdGraph* ById = FindGraphById(Blueprint, GraphIdValue);
			if (!ById)
			{
				OutError = FString::Printf(TEXT("Graph not found for graph_id: %s"), *GraphIdValue);
			}
			return ById;
		}
		const FString GraphNameValue = GetString(Args, TEXT("graph_name"), GetString(Args, TEXT("graph"), GetString(Args, TEXT("function_name"), GetString(Args, TEXT("macro_name")))));
		if (!GraphNameValue.IsEmpty())
		{
			bOutNamed = true;
			return ResolveGraph(Blueprint, GraphNameValue, OutError);
		}
		return nullptr;
	}

	void AppendGraphSummaries(UBlueprint* Blueprint, bool bIncludeSubGraphs, TArray<TSharedPtr<FJsonValue>>& OutGraphs)
	{
		TArray<UEdGraph*> Graphs;
		AppendGraphs(Blueprint, Graphs, bIncludeSubGraphs);
		for (UEdGraph* Graph : Graphs)
		{
			if (!Graph)
			{
				continue;
			}
			FJsonObjectPtr Entry = MakeObject();
			Entry->SetStringField(TEXT("graph_id"), GraphId(Graph));
			Entry->SetStringField(TEXT("name"), Graph->GetName());
			Entry->SetStringField(TEXT("kind"), GraphKind(Graph));
			Entry->SetStringField(TEXT("owner"), Blueprint ? Blueprint->GetPathName() : FString());
			if (UEdGraph* Parent = FindParentGraph(Graph))
			{
				Entry->SetStringField(TEXT("parent_graph_id"), GraphId(Parent));
			}
			Entry->SetNumberField(TEXT("node_count"), Graph->Nodes.Num());
			Entry->SetStringField(TEXT("schema"), Graph->Schema ? Graph->Schema->GetName() : FString());
			OutGraphs.Add(MakeShared<FJsonValueObject>(Entry));
		}
	}

	FJsonObjectPtr MakeCodedError(const FString& Code, const FString& Message)
	{
		FJsonObjectPtr Result = MakeErrorObject(Message);
		FJsonObjectPtr ErrorObject = MakeObject();
		ErrorObject->SetStringField(TEXT("code"), Code);
		ErrorObject->SetStringField(TEXT("message"), Message);
		Result->SetObjectField(TEXT("error"), ErrorObject);
		return Result;
	}

	FJsonObjectPtr MakeGraphNotFoundError(const FString& Requested, UBlueprint* Blueprint)
	{
		FJsonObjectPtr Result = MakeCodedError(
			TEXT("graph_not_found"),
			FString::Printf(TEXT("Graph not found: %s"), *Requested));
		TArray<TSharedPtr<FJsonValue>> Candidates;
		AppendGraphSummaries(Blueprint, true, Candidates);
		FJsonObjectPtr ErrorObject = Result->GetObjectField(TEXT("error"));
		ErrorObject->SetArrayField(TEXT("candidates"), Candidates);
		return Result;
	}

	FJsonObjectPtr MakeGraphEnvelope(UBlueprint* Blueprint)
	{
		FJsonObjectPtr Result = MakeObject();
		TArray<TSharedPtr<FJsonValue>> Graphs;
		AppendGraphSummaries(Blueprint, false, Graphs);
		Result->SetArrayField(TEXT("graphs"), Graphs);
		return Result;
	}

	bool GuardGraphMutation(const FString& ActionLabel, FJsonObjectPtr& OutRefusal)
	{
		int32 PieWorldCount = 0;
		if (!IsPlayInEditorActive(PieWorldCount) || UnsafeOperationsAllowed())
		{
			return false;
		}
		OutRefusal = MakeGuardRefusal(
			TEXT("pie-editor-mutation"),
			TEXT("Refuse editor-world mutations while Play In Editor is running"),
			FString::Printf(
				TEXT("Refusing to %s: Play In Editor is running (%d PIE world(s))."),
				*ActionLabel,
				PieWorldCount),
			TEXT("Stop Play In Editor first, then retry. Set UEV_ALLOW_UNSAFE_OPERATIONS=1 only for a deliberate, backed-up operation."));
		return true;
	}

	bool IsConstructionScriptGraph(UBlueprint* Blueprint, UEdGraph* Graph)
	{
		return Blueprint && Graph && FBlueprintEditorUtils::FindUserConstructionScript(Blueprint) == Graph;
	}

	FString SerializePinTypeField(const FEdGraphPinType& Type)
	{
		FString Result;
		const bool bArray = Type.IsArray();
		if (Type.PinCategory == UEdGraphSchema_K2::PC_Boolean)
		{
			Result = TEXT("bool");
		}
		else if (Type.PinCategory == UEdGraphSchema_K2::PC_Int)
		{
			Result = TEXT("int");
		}
		else if (Type.PinCategory == UEdGraphSchema_K2::PC_Float)
		{
			Result = TEXT("float");
		}
		else if (Type.PinCategory == UEdGraphSchema_K2::PC_String)
		{
			Result = TEXT("string");
		}
		else if (Type.PinCategory == UEdGraphSchema_K2::PC_Name)
		{
			Result = TEXT("name");
		}
		else if (Type.PinCategory == UEdGraphSchema_K2::PC_Text)
		{
			Result = TEXT("text");
		}
		else if (Type.PinCategory == UEdGraphSchema_K2::PC_Object || Type.PinCategory == UEdGraphSchema_K2::PC_Class)
		{
			const FString Prefix = Type.PinCategory == UEdGraphSchema_K2::PC_Object ? TEXT("object:") : TEXT("class:");
			Result = Prefix + (Type.PinSubCategoryObject.IsValid() ? Type.PinSubCategoryObject->GetPathName() : FString());
		}
		else if (Type.PinCategory == UEdGraphSchema_K2::PC_Struct)
		{
			const UScriptStruct* Struct = Cast<UScriptStruct>(Type.PinSubCategoryObject.Get());
			if (Struct == TBaseStructure<FVector>::Get())
			{
				Result = TEXT("vector");
			}
			else if (Struct == TBaseStructure<FRotator>::Get())
			{
				Result = TEXT("rotator");
			}
			else if (Struct == TBaseStructure<FTransform>::Get())
			{
				Result = TEXT("transform");
			}
			else if (Struct == TBaseStructure<FLinearColor>::Get())
			{
				Result = TEXT("linearcolor");
			}
			else
			{
				Result = PinTypeName(Type);
			}
		}
		else
		{
			Result = PinTypeName(Type);
		}
		return bArray ? FString::Printf(TEXT("array:%s"), *Result) : Result;
	}

	bool PinTypeFromArgs(const FJsonObject& Args, const FString& Field, const FString& DefaultType, FEdGraphPinType& OutType, FString& OutError)
	{
		FString TypeName = GetString(Args, Field, GetString(Args, TEXT("variable_type"), DefaultType));
		TypeName = TypeName.TrimStartAndEnd().ToLower();
		if (TypeName.IsEmpty())
		{
			TypeName = DefaultType.ToLower();
		}

		bool bArray = false;
		if (TypeName.StartsWith(TEXT("array:")))
		{
			bArray = true;
			TypeName.RightChopInline(6);
		}

		OutType = FEdGraphPinType();
		OutType.ContainerType = bArray ? EPinContainerType::Array : EPinContainerType::None;

		if (TypeName == TEXT("bool") || TypeName == TEXT("boolean"))
		{
			OutType.PinCategory = UEdGraphSchema_K2::PC_Boolean;
		}
		else if (TypeName == TEXT("int") || TypeName == TEXT("integer"))
		{
			OutType.PinCategory = UEdGraphSchema_K2::PC_Int;
		}
		else if (TypeName == TEXT("float") || TypeName == TEXT("real"))
		{
			OutType.PinCategory = UEdGraphSchema_K2::PC_Float;
		}
		else if (TypeName == TEXT("string"))
		{
			OutType.PinCategory = UEdGraphSchema_K2::PC_String;
		}
		else if (TypeName == TEXT("name"))
		{
			OutType.PinCategory = UEdGraphSchema_K2::PC_Name;
		}
		else if (TypeName == TEXT("text"))
		{
			OutType.PinCategory = UEdGraphSchema_K2::PC_Text;
		}
		else if (TypeName == TEXT("vector") || TypeName == TEXT("rotator") || TypeName == TEXT("transform")
			|| TypeName == TEXT("linearcolor") || TypeName == TEXT("color"))
		{
			OutType.PinCategory = UEdGraphSchema_K2::PC_Struct;
			if (TypeName == TEXT("vector"))
			{
				OutType.PinSubCategoryObject = TBaseStructure<FVector>::Get();
			}
			else if (TypeName == TEXT("rotator"))
			{
				OutType.PinSubCategoryObject = TBaseStructure<FRotator>::Get();
			}
			else if (TypeName == TEXT("transform"))
			{
				OutType.PinSubCategoryObject = TBaseStructure<FTransform>::Get();
			}
			else
			{
				OutType.PinSubCategoryObject = TBaseStructure<FLinearColor>::Get();
			}
		}
		else if (TypeName.StartsWith(TEXT("object:")) || TypeName.StartsWith(TEXT("class:")))
		{
			const bool bIsClass = TypeName.StartsWith(TEXT("class:"));
			const FString ClassName = TypeName.RightChop(bIsClass ? 6 : 7);
			UClass* Resolved = ResolveClass(ClassName, UObject::StaticClass(), OutError);
			if (!Resolved)
			{
				return false;
			}
			OutType.PinCategory = bIsClass ? UEdGraphSchema_K2::PC_Class : UEdGraphSchema_K2::PC_Object;
			OutType.PinSubCategoryObject = Resolved;
		}
		else
		{
			OutError = FString::Printf(TEXT("Unsupported variable type: %s"), *TypeName);
			return false;
		}
		return true;
	}
}
