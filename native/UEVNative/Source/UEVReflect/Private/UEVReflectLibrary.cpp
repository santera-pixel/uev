#include "UEVReflectLibrary.h"

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "GameFramework/Actor.h"
#include "Components/ActorComponent.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UObject/UnrealType.h"

namespace
{
	FString KindOf(const FProperty* Property)
	{
		if (!Property)
		{
			return TEXT("none");
		}

		if (CastField<const FBoolProperty>(Property)) { return TEXT("bool"); }
		if (CastField<const FIntProperty>(Property)) { return TEXT("int"); }
		if (CastField<const FInt64Property>(Property)) { return TEXT("int64"); }
		if (CastField<const FFloatProperty>(Property)) { return TEXT("float"); }
		if (CastField<const FDoubleProperty>(Property)) { return TEXT("double"); }
		if (CastField<const FStrProperty>(Property)) { return TEXT("string"); }
		if (CastField<const FNameProperty>(Property)) { return TEXT("name"); }
		if (CastField<const FTextProperty>(Property)) { return TEXT("text"); }
		if (CastField<const FEnumProperty>(Property)) { return TEXT("enum"); }

		if (const FByteProperty* ByteProperty = CastField<const FByteProperty>(Property))
		{
			return ByteProperty->Enum ? TEXT("enum") : TEXT("byte");
		}
		if (const FStructProperty* StructProperty = CastField<const FStructProperty>(Property))
		{
			return FString::Printf(TEXT("struct:%s"), StructProperty->Struct ? *StructProperty->Struct->GetName() : TEXT("?"));
		}
		if (const FArrayProperty* ArrayProperty = CastField<const FArrayProperty>(Property))
		{
			return FString::Printf(TEXT("array<%s>"), *KindOf(ArrayProperty->Inner));
		}
		if (const FSetProperty* SetProperty = CastField<const FSetProperty>(Property))
		{
			return FString::Printf(TEXT("set<%s>"), *KindOf(SetProperty->ElementProp));
		}
		if (const FMapProperty* MapProperty = CastField<const FMapProperty>(Property))
		{
			return FString::Printf(TEXT("map<%s,%s>"), *KindOf(MapProperty->KeyProp), *KindOf(MapProperty->ValueProp));
		}
		if (const FObjectProperty* ObjectProperty = CastField<const FObjectProperty>(Property))
		{
			return FString::Printf(TEXT("object:%s"), ObjectProperty->PropertyClass ? *ObjectProperty->PropertyClass->GetName() : TEXT("?"));
		}
		if (const FSoftObjectProperty* SoftObjectProperty = CastField<const FSoftObjectProperty>(Property))
		{
			return FString::Printf(TEXT("softobject:%s"), SoftObjectProperty->PropertyClass ? *SoftObjectProperty->PropertyClass->GetName() : TEXT("?"));
		}
		if (CastField<const FClassProperty>(Property)) { return TEXT("class"); }
		if (CastField<const FInterfaceProperty>(Property)) { return TEXT("interface"); }
		return TEXT("other");
	}

	UEnum* EnumOf(const FProperty* Property)
	{
		if (const FEnumProperty* EnumProperty = CastField<const FEnumProperty>(Property))
		{
			return EnumProperty->GetEnum();
		}
		if (const FByteProperty* ByteProperty = CastField<const FByteProperty>(Property))
		{
			return ByteProperty->Enum;
		}
		return nullptr;
	}

	FString MetadataValue(const FProperty* Property, const TCHAR* Key)
	{
		return Property ? Property->GetMetaData(Key) : FString();
	}

	FProperty* FindPropertyInStruct(const UStruct* Struct, const FString& Name)
	{
		if (!Struct)
		{
			return nullptr;
		}

		for (TFieldIterator<FProperty> It(Struct); It; ++It)
		{
			if (It->GetName().Equals(Name, ESearchCase::IgnoreCase))
			{
				return *It;
			}
		}
		return nullptr;
	}

	struct FPathStep
	{
		bool bIsIndex = false;
		bool bIsMapKey = false;
		FString Name;
		int32 Index = 0;
		FString MapKey;
	};

	bool ParsePath(const FString& Path, TArray<FPathStep>& OutSteps, FString& OutError)
	{
		FString Remaining = Path;
		while (!Remaining.IsEmpty())
		{
			FPathStep Step;

			const int32 DotIndex = Remaining.Find(TEXT("."));
			FString Chunk = DotIndex == INDEX_NONE ? Remaining : Remaining.Left(DotIndex);
			Remaining = DotIndex == INDEX_NONE ? FString() : Remaining.Mid(DotIndex + 1);

			while (!Chunk.IsEmpty())
			{
				if (Chunk.StartsWith(TEXT("[")))
				{
					const int32 Close = Chunk.Find(TEXT("]"));
					if (Close == INDEX_NONE)
					{
						OutError = FString::Printf(TEXT("unterminated index in path segment '%s'"), *Chunk);
						return false;
					}
					FPathStep IndexStep;
					IndexStep.bIsIndex = true;
					IndexStep.Index = FCString::Atoi(*Chunk.Mid(1, Close - 1));
					OutSteps.Add(IndexStep);
					Chunk = Chunk.Mid(Close + 1);
					continue;
				}

				if (Chunk.StartsWith(TEXT("{")))
				{
					const int32 Close = Chunk.Find(TEXT("}"));
					if (Close == INDEX_NONE)
					{
						OutError = FString::Printf(TEXT("unterminated map key in path segment '%s'"), *Chunk);
						return false;
					}
					FPathStep KeyStep;
					KeyStep.bIsMapKey = true;
					KeyStep.MapKey = Chunk.Mid(1, Close - 1);
					OutSteps.Add(KeyStep);
					Chunk = Chunk.Mid(Close + 1);
					continue;
				}

				const int32 SuffixStart = Chunk.Find(TEXT("["));
				const int32 KeyStart = Chunk.Find(TEXT("{"));
				int32 Cut = INDEX_NONE;
				if (SuffixStart != INDEX_NONE && KeyStart != INDEX_NONE) { Cut = FMath::Min(SuffixStart, KeyStart); }
				else if (SuffixStart != INDEX_NONE) { Cut = SuffixStart; }
				else { Cut = KeyStart; }

				FPathStep NameStep;
				NameStep.Name = Cut == INDEX_NONE ? Chunk : Chunk.Left(Cut);
				Chunk = Cut == INDEX_NONE ? FString() : Chunk.Mid(Cut);
				OutSteps.Add(NameStep);
			}
		}

		if (OutSteps.Num() == 0)
		{
			OutError = TEXT("path is empty");
			return false;
		}
		return true;
	}

	/** Walks a property path, ending with the property that owns OutValuePtr. */
	bool ResolvePath(
		UObject* Root,
		const FString& Path,
		FProperty*& OutProperty,
		void*& OutValuePtr,
		UObject*& OutOwner,
		FString& OutError)
	{
		OutProperty = nullptr;
		OutValuePtr = nullptr;
		OutOwner = Root;

		if (!Root)
		{
			OutError = TEXT("target object is null");
			return false;
		}

		TArray<FPathStep> Steps;
		if (!ParsePath(Path, Steps, OutError))
		{
			return false;
		}

		UObject* CurrentOwner = Root;
		UStruct* CurrentStruct = Root->GetClass();
		void* CurrentContainer = Root;
		FProperty* CurrentProperty = nullptr;
		void* CurrentValue = nullptr;

		for (int32 StepIndex = 0; StepIndex < Steps.Num(); ++StepIndex)
		{
			const FPathStep& Step = Steps[StepIndex];
			const bool bLast = StepIndex == Steps.Num() - 1;

			if (Step.bIsIndex)
			{
				FArrayProperty* ArrayProperty = CastField<FArrayProperty>(CurrentProperty);
				if (!ArrayProperty || !CurrentValue)
				{
					OutError = FString::Printf(TEXT("'%s' is not an array property"), CurrentProperty ? *CurrentProperty->GetName() : TEXT("?"));
					return false;
				}

				FScriptArrayHelper Helper(ArrayProperty, CurrentValue);
				if (Step.Index < 0 || Step.Index >= Helper.Num())
				{
					OutError = FString::Printf(TEXT("index %d out of range (0..%d)"), Step.Index, Helper.Num() - 1);
					return false;
				}

				CurrentProperty = ArrayProperty->Inner;
				CurrentValue = Helper.GetRawPtr(Step.Index);
				CurrentStruct = CastField<FStructProperty>(CurrentProperty) ? CastField<FStructProperty>(CurrentProperty)->Struct : nullptr;
				CurrentContainer = CurrentValue;
				continue;
			}

			if (Step.bIsMapKey)
			{
				FMapProperty* MapProperty = CastField<FMapProperty>(CurrentProperty);
				if (!MapProperty || !CurrentValue)
				{
					OutError = FString::Printf(TEXT("'%s' is not a map property"), CurrentProperty ? *CurrentProperty->GetName() : TEXT("?"));
					return false;
				}

				FScriptMapHelper Helper(MapProperty, CurrentValue);
				void* FoundValue = nullptr;
				for (int32 SparseIndex = 0; SparseIndex < Helper.GetMaxIndex(); ++SparseIndex)
				{
					if (!Helper.IsValidIndex(SparseIndex))
					{
						continue;
					}
					FString KeyText;
					MapProperty->KeyProp->ExportTextItem(KeyText, Helper.GetKeyPtr(SparseIndex), nullptr, CurrentOwner, PPF_None);
					KeyText = KeyText.TrimQuotes();
					if (KeyText.Equals(Step.MapKey, ESearchCase::IgnoreCase))
					{
						FoundValue = Helper.GetValuePtr(SparseIndex);
						break;
					}
				}

				if (!FoundValue)
				{
					OutError = FString::Printf(TEXT("map key '%s' not found"), *Step.MapKey);
					return false;
				}

				CurrentProperty = MapProperty->ValueProp;
				CurrentValue = FoundValue;
				CurrentStruct = CastField<FStructProperty>(CurrentProperty) ? CastField<FStructProperty>(CurrentProperty)->Struct : nullptr;
				CurrentContainer = CurrentValue;
				continue;
			}

			if (!CurrentStruct)
			{
				OutError = FString::Printf(TEXT("cannot descend into '%s': previous property is not a struct or object"), *Step.Name);
				return false;
			}

			FProperty* Found = FindPropertyInStruct(CurrentStruct, Step.Name);
			if (!Found)
			{
				OutError = FString::Printf(TEXT("property '%s' not found on %s"), *Step.Name, *CurrentStruct->GetName());
				return false;
			}

			CurrentProperty = Found;
			CurrentValue = Found->ContainerPtrToValuePtr<void>(CurrentContainer);

			if (const FObjectProperty* ObjectProperty = CastField<FObjectProperty>(Found))
			{
				UObject* Child = ObjectProperty->GetObjectPropertyValue(CurrentValue);
				if (!bLast)
				{
					if (!Child)
					{
						OutError = FString::Printf(TEXT("'%s' is null, cannot descend further"), *Step.Name);
						return false;
					}
					CurrentOwner = Child;
					CurrentStruct = Child->GetClass();
					CurrentContainer = Child;
				}
			}
			else if (const FStructProperty* StructProperty = CastField<FStructProperty>(Found))
			{
				CurrentStruct = StructProperty->Struct;
				CurrentContainer = CurrentValue;
			}
			else
			{
				CurrentStruct = nullptr;
				CurrentContainer = nullptr;
			}
		}

		OutProperty = CurrentProperty;
		OutValuePtr = CurrentValue;
		OutOwner = CurrentOwner;
		return OutProperty != nullptr && OutValuePtr != nullptr;
	}

	TSharedPtr<FJsonObject> MakePropertySchema(const FProperty* Property)
	{
		TSharedPtr<FJsonObject> Entry = MakeShareable(new FJsonObject());
		Entry->SetStringField(TEXT("name"), Property->GetName());
		Entry->SetStringField(TEXT("kind"), KindOf(Property));
		Entry->SetStringField(TEXT("cpp_type"), Property->GetCPPType());
		Entry->SetBoolField(TEXT("editable"), Property->HasAnyPropertyFlags(CPF_Edit));
		Entry->SetBoolField(TEXT("edit_const"), Property->HasAnyPropertyFlags(CPF_EditConst));
		Entry->SetBoolField(TEXT("blueprint_visible"), Property->HasAnyPropertyFlags(CPF_BlueprintVisible));

		const FString Category = MetadataValue(Property, TEXT("Category"));
		if (!Category.IsEmpty()) { Entry->SetStringField(TEXT("category"), Category); }
		const FString ToolTip = MetadataValue(Property, TEXT("ToolTip"));
		if (!ToolTip.IsEmpty()) { Entry->SetStringField(TEXT("tooltip"), ToolTip); }
		const FString ClampMin = MetadataValue(Property, TEXT("ClampMin"));
		if (!ClampMin.IsEmpty()) { Entry->SetStringField(TEXT("clamp_min"), ClampMin); }
		const FString ClampMax = MetadataValue(Property, TEXT("ClampMax"));
		if (!ClampMax.IsEmpty()) { Entry->SetStringField(TEXT("clamp_max"), ClampMax); }

		if (const UEnum* Enum = EnumOf(Property))
		{
			TArray<TSharedPtr<FJsonValue>> Values;
			const int32 Count = Enum->NumEnums();
			for (int32 Index = 0; Index < Count; ++Index)
			{
				const FString EnumName = Enum->GetNameStringByIndex(Index);
				if (EnumName.EndsWith(TEXT("_MAX")))
				{
					continue;
				}
				Values.Add(MakeShareable(new FJsonValueString(EnumName)));
			}
			Entry->SetArrayField(TEXT("values"), Values);
		}

		return Entry;
	}

	int32 EditDistanceBounded(const FString& A, const FString& B, int32 MaxDistance)
	{
		const int32 LenA = A.Len();
		const int32 LenB = B.Len();
		if (FMath::Abs(LenA - LenB) > MaxDistance)
		{
			return MaxDistance + 1;
		}

		TArray<int32> Previous;
		TArray<int32> Current;
		Previous.SetNumUninitialized(LenB + 1);
		Current.SetNumUninitialized(LenB + 1);
		for (int32 Index = 0; Index <= LenB; ++Index)
		{
			Previous[Index] = Index;
		}
		for (int32 Row = 1; Row <= LenA; ++Row)
		{
			Current[0] = Row;
			int32 RowMin = Current[0];
			for (int32 Column = 1; Column <= LenB; ++Column)
			{
				const int32 Cost = A[Row - 1] == B[Column - 1] ? 0 : 1;
				Current[Column] = FMath::Min3(Previous[Column] + 1, Current[Column - 1] + 1, Previous[Column - 1] + Cost);
				RowMin = FMath::Min(RowMin, Current[Column]);
			}
			if (RowMin > MaxDistance)
			{
				return MaxDistance + 1;
			}
			Swap(Previous, Current);
		}
		return Previous[LenB];
	}

	FString NormalizeFunctionNameForMatch(const FString& InName)
	{
		FString Name = InName.ToLower();
		if (Name.StartsWith(TEXT("k2_")))
		{
			Name = Name.RightChop(3);
		}
		Name.ReplaceInline(TEXT("_"), TEXT(""));
		return Name;
	}

	void CollectFunctionSuggestions(UObject* Object, const FString& FunctionName, TArray<FString>& OutNames)
	{
		if (!Object)
		{
			return;
		}

		const FString Request = NormalizeFunctionNameForMatch(FunctionName);
		if (Request.Len() < 3)
		{
			return;
		}

		TArray<TPair<int32, FString>> Scored;
		for (TFieldIterator<UFunction> It(Object->GetClass()); It; ++It)
		{
			UFunction* Candidate = *It;
			if (!Candidate || !Candidate->HasAnyFunctionFlags(FUNC_Public | FUNC_BlueprintCallable) || Candidate->HasAnyFunctionFlags(FUNC_Delegate))
			{
				continue;
			}

			const FString CandidateName = Candidate->GetName();
			const FString Normalized = NormalizeFunctionNameForMatch(CandidateName);
			if (Normalized.IsEmpty())
			{
				continue;
			}

			const int32 LengthDelta = FMath::Abs(Normalized.Len() - Request.Len());
			const bool bSubstring = Normalized.Contains(Request) || Request.Contains(Normalized);
			int32 Score = LengthDelta;
			if (!bSubstring)
			{
				// A missing or extra character ("GetActorLocaton") does not contain the real name,
				// so fall back to a small edit distance before giving up on suggestions.
				const int32 MaxDistance = FMath::Max(2, Request.Len() / 4);
				const int32 Distance = EditDistanceBounded(Normalized, Request, MaxDistance);
				if (Distance > MaxDistance)
				{
					continue;
				}
				Score = Distance * 10 + LengthDelta;
			}

			Scored.Emplace(Score, CandidateName);
		}

		Scored.Sort([](const TPair<int32, FString>& Left, const TPair<int32, FString>& Right)
		{
			return Left.Key == Right.Key ? Left.Value < Right.Value : Left.Key < Right.Key;
		});

		for (const TPair<int32, FString>& Entry : Scored)
		{
			if (OutNames.Num() >= 6)
			{
				break;
			}
			OutNames.Add(Entry.Value);
		}
	}

	UFunction* FindFunctionLoose(UObject* Object, const FString& FunctionName)
	{
		if (!Object || FunctionName.IsEmpty())
		{
			return nullptr;
		}

		if (UFunction* Exact = Object->FindFunction(FName(*FunctionName)))
		{
			return Exact;
		}

		for (TFieldIterator<UFunction> It(Object->GetClass()); It; ++It)
		{
			if (It->GetName().Equals(FunctionName, ESearchCase::IgnoreCase))
			{
				return *It;
			}
		}
		return nullptr;
	}
}

UClass* UUEVReflectLibrary::ResolveClass(const FString& ClassName)
{
	const FString Name = ClassName.TrimStartAndEnd();
	if (Name.IsEmpty())
	{
		return nullptr;
	}

	if (Name.StartsWith(TEXT("/")))
	{
		if (UClass* Direct = LoadObject<UClass>(nullptr, *Name))
		{
			return Direct;
		}
	}

	FString ShortName = Name;
	int32 DotIndex = INDEX_NONE;
	if (Name.FindLastChar(TEXT('.'), DotIndex))
	{
		ShortName = Name.Mid(DotIndex + 1);
	}

	if (Name.Contains(TEXT(".")))
	{
		static const TCHAR* Prefixes[] = {
			TEXT("/Script/Engine."),
			TEXT("/Script/CoreUObject."),
			TEXT("/Script/UnrealEd."),
			TEXT("/Script/AIModule.")
		};

		for (const TCHAR* Prefix : Prefixes)
		{
			const FString Candidate = FString(Prefix) + ShortName;
			if (UClass* Loaded = LoadObject<UClass>(nullptr, *Candidate))
			{
				return Loaded;
			}
		}
	}

	UClass* Best = nullptr;
	for (TObjectIterator<UClass> It; It; ++It)
	{
		UClass* Candidate = *It;
		if (!Candidate || Candidate->HasAnyClassFlags(CLASS_Deprecated | CLASS_NewerVersionExists))
		{
			continue;
		}

		const FString CandidateName = Candidate->GetName();
		if (!CandidateName.Equals(ShortName, ESearchCase::IgnoreCase) && !CandidateName.Equals(ShortName + TEXT("_C"), ESearchCase::IgnoreCase))
		{
			continue;
		}

		if (!Best || (Best->HasAnyClassFlags(CLASS_Abstract) && !Candidate->HasAnyClassFlags(CLASS_Abstract)))
		{
			Best = Candidate;
		}
	}

	return Best;
}

FString UUEVReflectLibrary::DescribeClass(UClass* Class, bool bIncludeFunctions)
{
	if (!Class)
	{
		return TEXT("{\"error\":\"class is null\"}");
	}

	TSharedPtr<FJsonObject> Root = MakeShareable(new FJsonObject());
	Root->SetStringField(TEXT("class"), Class->GetName());
	Root->SetStringField(TEXT("path"), Class->GetPathName());

	FString ParentChain;
	for (UClass* Current = Class->GetSuperClass(); Current && Current != UObject::StaticClass(); Current = Current->GetSuperClass())
	{
		ParentChain += ParentChain.IsEmpty() ? Current->GetName() : FString::Printf(TEXT("<%s"), *Current->GetName());
	}
	if (!ParentChain.IsEmpty())
	{
		Root->SetStringField(TEXT("inherits"), ParentChain);
	}

	TArray<TSharedPtr<FJsonValue>> Properties;
	for (TFieldIterator<FProperty> It(Class); It; ++It)
	{
		Properties.Add(MakeShareable(new FJsonValueObject(MakePropertySchema(*It))));
	}
	Root->SetArrayField(TEXT("properties"), Properties);
	Root->SetNumberField(TEXT("property_count"), Properties.Num());

	if (bIncludeFunctions)
	{
		TArray<TSharedPtr<FJsonValue>> Functions;
		for (TFieldIterator<UFunction> It(Class); It; ++It)
		{
			UFunction* Function = *It;
			if (!Function || !Function->HasAnyFunctionFlags(FUNC_Public | FUNC_BlueprintCallable))
			{
				continue;
			}
			if (Function->HasAnyFunctionFlags(FUNC_Delegate))
			{
				continue;
			}

			TSharedPtr<FJsonObject> Entry = MakeShareable(new FJsonObject());
			Entry->SetStringField(TEXT("name"), Function->GetName());
			Entry->SetBoolField(TEXT("static"), Function->HasAnyFunctionFlags(FUNC_Static));
			Entry->SetBoolField(TEXT("const"), Function->HasAnyFunctionFlags(FUNC_Const));

			TArray<TSharedPtr<FJsonValue>> Params;
			for (TFieldIterator<FProperty> ParamIt(Function); ParamIt && ParamIt->HasAnyPropertyFlags(CPF_Parm); ++ParamIt)
			{
				if (ParamIt->HasAnyPropertyFlags(CPF_ReturnParm))
				{
					Entry->SetStringField(TEXT("returns"), KindOf(*ParamIt));
					continue;
				}
				TSharedPtr<FJsonObject> Param = MakeShareable(new FJsonObject());
				Param->SetStringField(TEXT("name"), ParamIt->GetName());
				Param->SetStringField(TEXT("kind"), KindOf(*ParamIt));
				Params.Add(MakeShareable(new FJsonValueObject(Param)));
			}
			Entry->SetArrayField(TEXT("params"), Params);
			Functions.Add(MakeShareable(new FJsonValueObject(Entry)));
		}
		Root->SetArrayField(TEXT("functions"), Functions);
	}

	FString Output;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
	FJsonSerializer::Serialize(Root.ToSharedRef(), Writer);
	return Output;
}

FString UUEVReflectLibrary::DescribeObject(UObject* Object, bool bIncludeValues)
{
	if (!Object)
	{
		return TEXT("{\"error\":\"object is null\"}");
	}

	TSharedPtr<FJsonObject> Root = MakeShareable(new FJsonObject());
	Root->SetStringField(TEXT("name"), Object->GetName());
	Root->SetStringField(TEXT("path"), Object->GetPathName());
	Root->SetStringField(TEXT("class"), Object->GetClass()->GetName());
	Root->SetStringField(TEXT("class_path"), Object->GetClass()->GetPathName());

	if (const AActor* Actor = Cast<AActor>(Object))
	{
		TSharedPtr<FJsonObject> Transform = MakeShareable(new FJsonObject());
		const FVector Location = Actor->GetActorLocation();
		const FRotator Rotation = Actor->GetActorRotation();
		const FVector Scale = Actor->GetActorScale3D();
		Transform->SetNumberField(TEXT("x"), Location.X);
		Transform->SetNumberField(TEXT("y"), Location.Y);
		Transform->SetNumberField(TEXT("z"), Location.Z);
		Root->SetObjectField(TEXT("location"), Transform);

		TSharedPtr<FJsonObject> Rot = MakeShareable(new FJsonObject());
		Rot->SetNumberField(TEXT("pitch"), Rotation.Pitch);
		Rot->SetNumberField(TEXT("yaw"), Rotation.Yaw);
		Rot->SetNumberField(TEXT("roll"), Rotation.Roll);
		Root->SetObjectField(TEXT("rotation"), Rot);

		TSharedPtr<FJsonObject> ScaleObject = MakeShareable(new FJsonObject());
		ScaleObject->SetNumberField(TEXT("x"), Scale.X);
		ScaleObject->SetNumberField(TEXT("y"), Scale.Y);
		ScaleObject->SetNumberField(TEXT("z"), Scale.Z);
		Root->SetObjectField(TEXT("scale"), ScaleObject);

		Root->SetStringField(TEXT("label"), Actor->GetActorLabel());
		Root->SetBoolField(TEXT("hidden"), Actor->IsHidden());
	}

	if (bIncludeValues)
	{
		TSharedPtr<FJsonObject> Values = MakeShareable(new FJsonObject());
		for (TFieldIterator<FProperty> It(Object->GetClass()); It; ++It)
		{
			FProperty* Property = *It;
			if (!Property->HasAnyPropertyFlags(CPF_Edit) || Property->HasAnyPropertyFlags(CPF_EditorOnly))
			{
				continue;
			}
			if (Property->ArrayDim > 1)
			{
				continue;
			}

			const void* ValuePtr = Property->ContainerPtrToValuePtr<void>(Object);
			FString ValueText;
			Property->ExportTextItem(ValueText, ValuePtr, nullptr, Object, PPF_None);
			Values->SetStringField(Property->GetName(), ValueText);
		}
		Root->SetObjectField(TEXT("values"), Values);
	}

	FString Output;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
	FJsonSerializer::Serialize(Root.ToSharedRef(), Writer);
	return Output;
}

FString UUEVReflectLibrary::GetProperty(UObject* Object, const FString& Path)
{
	FProperty* Property = nullptr;
	void* ValuePtr = nullptr;
	UObject* Owner = nullptr;
	FString Error;

	if (!ResolvePath(Object, Path, Property, ValuePtr, Owner, Error))
	{
		TSharedPtr<FJsonObject> Failure = MakeShareable(new FJsonObject());
		Failure->SetBoolField(TEXT("success"), false);
		Failure->SetStringField(TEXT("code"), TEXT("invalid_path"));
		Failure->SetStringField(TEXT("message"), Error);
		FString Output;
		const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
		FJsonSerializer::Serialize(Failure.ToSharedRef(), Writer);
		return Output;
	}

	FString ValueText;
	Property->ExportTextItem(ValueText, ValuePtr, nullptr, Owner, PPF_None);

	TSharedPtr<FJsonObject> Result = MakeShareable(new FJsonObject());
	Result->SetBoolField(TEXT("success"), true);
	Result->SetStringField(TEXT("path"), Path);
	Result->SetStringField(TEXT("kind"), KindOf(Property));
	Result->SetStringField(TEXT("value"), ValueText);
	Result->SetStringField(TEXT("property"), Property->GetName());

	FString Output;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
	FJsonSerializer::Serialize(Result.ToSharedRef(), Writer);
	return Output;
}

FString UUEVReflectLibrary::SetProperty(UObject* Object, const FString& Path, const FString& ValueText)
{
	FProperty* Property = nullptr;
	void* ValuePtr = nullptr;
	UObject* Owner = nullptr;
	FString Error;

	if (!ResolvePath(Object, Path, Property, ValuePtr, Owner, Error))
	{
		return FString::Printf(TEXT("invalid_path: %s"), *Error);
	}

	if (Property->HasAnyPropertyFlags(CPF_EditConst) && !Property->HasAnyPropertyFlags(CPF_Edit))
	{
		return FString::Printf(TEXT("read_only: '%s' is edit-const"), *Property->GetName());
	}

	FString PreviousText;
	Property->ExportTextItem(PreviousText, ValuePtr, nullptr, Owner, PPF_None);

	FStringOutputDevice ImportErrors;
	const TCHAR* Result = Property->ImportText(*ValueText, ValuePtr, PPF_None, Owner, &ImportErrors);
	if (!Result)
	{
		return FString::Printf(TEXT("type_mismatch: '%s' rejected '%s'%s"),
			*Property->GetName(),
			*ValueText,
			ImportErrors.IsEmpty() ? TEXT("") : *FString::Printf(TEXT(": %s"), *ImportErrors));
	}

	if (AActor* Actor = Cast<AActor>(Object))
	{
		if (USceneComponent* RootComponent = Actor->GetRootComponent())
		{
			RootComponent->UpdateComponentToWorld();
		}
	}

	Object->PostEditChange();

	return FString();
}

FString UUEVReflectLibrary::CallFunction(UObject* Object, const FString& FunctionName, const TArray<FString>& Arguments)
{
	if (!Object)
	{
		return TEXT("{\"success\":false,\"code\":\"not_found\",\"message\":\"target object is null\"}");
	}

	FString ResolvedFrom;
	FString Resolution;
	UFunction* Function = FindFunctionLoose(Object, FunctionName);
	if (Function)
	{
		Resolution = Function->GetName().Equals(FunctionName, ESearchCase::CaseSensitive) ? TEXT("exact") : TEXT("case_insensitive");
	}
	else
	{
		const bool bHasK2Prefix = FunctionName.StartsWith(TEXT("K2_"), ESearchCase::IgnoreCase);
		const FString Alias = bHasK2Prefix ? FunctionName.RightChop(3) : FString::Printf(TEXT("K2_%s"), *FunctionName);
		UFunction* AliasFunction = FindFunctionLoose(Object, Alias);
		if (AliasFunction)
		{
			Function = AliasFunction;
			ResolvedFrom = FunctionName;
			Resolution = bHasK2Prefix ? TEXT("alias_without_k2") : TEXT("alias_k2");
		}
	}

	if (!Function)
	{
		TArray<FString> Suggestions;
		CollectFunctionSuggestions(Object, FunctionName, Suggestions);
		FString Message = FString::Printf(TEXT("function '%s' not found on %s"), *FunctionName, *Object->GetClass()->GetName());
		if (Suggestions.Num() > 0)
		{
			Message += FString::Printf(TEXT("; did you mean %s?"), *FString::Join(Suggestions, TEXT(", ")));
		}
		else
		{
			Message += TEXT("; no callable function with a similar name exists on the class or its parents.");
		}

		TSharedPtr<FJsonObject> Failure = MakeShareable(new FJsonObject());
		Failure->SetBoolField(TEXT("success"), false);
		Failure->SetStringField(TEXT("code"), TEXT("not_found"));
		Failure->SetStringField(TEXT("message"), Message);
		Failure->SetStringField(TEXT("requested_function"), FunctionName);
		Failure->SetStringField(TEXT("class"), Object->GetClass()->GetName());
		Failure->SetStringField(TEXT("hint"), TEXT("Functions resolve by exact name, K2_ Blueprint alias, or case-insensitive name across the parent class chain. Retry with one of the suggestions."));
		if (Suggestions.Num() > 0)
		{
			TArray<TSharedPtr<FJsonValue>> Values;
			for (const FString& Suggestion : Suggestions)
			{
				Values.Add(MakeShareable(new FJsonValueString(Suggestion)));
			}
			Failure->SetArrayField(TEXT("suggestions"), Values);
		}

		FString Output;
		const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
		FJsonSerializer::Serialize(Failure.ToSharedRef(), Writer);
		return Output;
	}

	if (!Function->HasAnyFunctionFlags(FUNC_Public | FUNC_BlueprintCallable) || Function->HasAnyFunctionFlags(FUNC_Delegate))
	{
		TSharedPtr<FJsonObject> Failure = MakeShareable(new FJsonObject());
		Failure->SetBoolField(TEXT("success"), false);
		Failure->SetStringField(TEXT("code"), TEXT("read_only"));
		Failure->SetStringField(TEXT("message"), FString::Printf(TEXT("function '%s' is not callable"), *Function->GetName()));
		Failure->SetStringField(TEXT("requested_function"), FunctionName);
		Failure->SetStringField(TEXT("hint"), TEXT("Only Public or BlueprintCallable functions can be invoked, and delegates are excluded. Use a BlueprintCallable variant or set the property instead."));
		FString Output;
		const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
		FJsonSerializer::Serialize(Failure.ToSharedRef(), Writer);
		return Output;
	}

	uint8* Params = static_cast<uint8*>(FMemory::Malloc(Function->ParmsSize, 16));
	FMemory::Memzero(Params, Function->ParmsSize);

	int32 ArgumentIndex = 0;
	FProperty* ReturnProperty = nullptr;
	FString Error;

	for (TFieldIterator<FProperty> It(Function); It && It->HasAnyPropertyFlags(CPF_Parm); ++It)
	{
		FProperty* Param = *It;
		if (Param->HasAnyPropertyFlags(CPF_ReturnParm))
		{
			ReturnProperty = Param;
			continue;
		}

		if (ArgumentIndex >= Arguments.Num())
		{
			continue;
		}

		void* ParamValue = Param->ContainerPtrToValuePtr<void>(Params);
		FStringOutputDevice ImportErrors;
		if (!Param->ImportText(*Arguments[ArgumentIndex], ParamValue, PPF_None, Object, &ImportErrors))
		{
			Error = FString::Printf(TEXT("type_mismatch: parameter '%s' rejected '%s'"), *Param->GetName(), *Arguments[ArgumentIndex]);
			break;
		}
		++ArgumentIndex;
	}

	if (!Error.IsEmpty())
	{
		FMemory::Free(Params);
		return FString::Printf(TEXT("{\"success\":false,\"code\":\"type_mismatch\",\"message\":\"%s\"}"), *Error);
	}

	Object->ProcessEvent(Function, Params);

	TSharedPtr<FJsonObject> Result = MakeShareable(new FJsonObject());
	Result->SetBoolField(TEXT("success"), true);
	Result->SetStringField(TEXT("function"), Function->GetName());
	Result->SetStringField(TEXT("resolution"), Resolution);
	if (!ResolvedFrom.IsEmpty())
	{
		Result->SetStringField(TEXT("resolved_from"), ResolvedFrom);
	}

	if (ReturnProperty)
	{
		const void* ReturnValue = ReturnProperty->ContainerPtrToValuePtr<void>(Params);
		FString ReturnText;
		ReturnProperty->ExportTextItem(ReturnText, ReturnValue, nullptr, Object, PPF_None);
		Result->SetStringField(TEXT("return"), ReturnText);
	}

	TArray<TSharedPtr<FJsonValue>> OutParams;
	for (TFieldIterator<FProperty> It(Function); It && It->HasAnyPropertyFlags(CPF_Parm); ++It)
	{
		FProperty* Param = *It;
		if (!Param->HasAnyPropertyFlags(CPF_OutParm) || Param->HasAnyPropertyFlags(CPF_ReturnParm))
		{
			continue;
		}
		const void* ParamValue = Param->ContainerPtrToValuePtr<void>(Params);
		FString ParamText;
		Param->ExportTextItem(ParamText, ParamValue, nullptr, Object, PPF_None);
		TSharedPtr<FJsonObject> Entry = MakeShareable(new FJsonObject());
		Entry->SetStringField(TEXT("name"), Param->GetName());
		Entry->SetStringField(TEXT("value"), ParamText);
		OutParams.Add(MakeShareable(new FJsonValueObject(Entry)));
	}
	if (OutParams.Num() > 0)
	{
		Result->SetArrayField(TEXT("out"), OutParams);
	}

	FMemory::Free(Params);

	FString Output;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
	FJsonSerializer::Serialize(Result.ToSharedRef(), Writer);
	return Output;
}

bool UUEVReflectLibrary::MarkModified(const TArray<UObject*>& Objects)
{
	bool bMarkedAny = false;

	for (UObject* Object : Objects)
	{
		if (!Object)
		{
			continue;
		}

		Object->Modify();
		bMarkedAny = true;

		if (AActor* Actor = Cast<AActor>(Object))
		{
			TArray<UActorComponent*> Components;
			Actor->GetComponents(Components);
			for (UActorComponent* Component : Components)
			{
				if (Component)
				{
					Component->Modify();
				}
			}
		}
	}

	return bMarkedAny;
}

FString UUEVReflectLibrary::DescribeFunction(UFunction* Function)
{
	if (!Function)
	{
		return TEXT("{\"error\":\"function is null\"}");
	}

	TSharedPtr<FJsonObject> Root = MakeShareable(new FJsonObject());
	Root->SetStringField(TEXT("name"), Function->GetName());

	TArray<TSharedPtr<FJsonValue>> Params;
	for (TFieldIterator<FProperty> It(Function); It && It->HasAnyPropertyFlags(CPF_Parm); ++It)
	{
		FProperty* Param = *It;
		if (Param->HasAnyPropertyFlags(CPF_ReturnParm))
		{
			Root->SetStringField(TEXT("returns"), KindOf(Param));
			continue;
		}
		TSharedPtr<FJsonObject> Entry = MakeShareable(new FJsonObject());
		Entry->SetStringField(TEXT("name"), Param->GetName());
		Entry->SetStringField(TEXT("kind"), KindOf(Param));
		Entry->SetBoolField(TEXT("out"), Param->HasAnyPropertyFlags(CPF_OutParm));
		Params.Add(MakeShareable(new FJsonValueObject(Entry)));
	}
	Root->SetArrayField(TEXT("params"), Params);

	FString Output;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
	FJsonSerializer::Serialize(Root.ToSharedRef(), Writer);
	return Output;
}
