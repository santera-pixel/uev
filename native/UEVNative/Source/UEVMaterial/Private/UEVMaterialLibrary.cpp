#include "UEVMaterialLibrary.h"

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "MaterialShared.h"
#include "Materials/MaterialInstance.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

namespace
{
	FString SerializeJson(const TSharedRef<FJsonObject>& Object)
	{
		FString Output;
		const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
			TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Output);

		FJsonSerializer::Serialize(Object, Writer);
		return Output;
	}

	int32 FindSwitchIndex(const FStaticParameterSet& Parameters, const FName& Name)
	{
		for (int32 Index = 0; Index < Parameters.StaticSwitchParameters.Num(); ++Index)
		{
			if (Parameters.StaticSwitchParameters[Index].ParameterInfo.Name == Name)
			{
				return Index;
			}
		}

		return INDEX_NONE;
	}
}

FString UUEVMaterialLibrary::SetMaterialInstanceStaticSwitch(UMaterialInstance* Instance, const FString& ParameterName, bool Value)
{
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), false);
	Result->SetBoolField(TEXT("found"), false);
	Result->SetStringField(TEXT("parameter"), ParameterName);

	if (!Instance)
	{
		Result->SetStringField(TEXT("message"), TEXT("No material instance was supplied."));
		return SerializeJson(Result);
	}

	const FName Name(*ParameterName);
	if (Name.IsNone())
	{
		Result->SetStringField(TEXT("message"), TEXT("A static switch parameter name is required."));
		return SerializeJson(Result);
	}

	FStaticParameterSet Parameters;
	Instance->GetStaticParameterValues(Parameters);

	const int32 Index = FindSwitchIndex(Parameters, Name);
	if (Index == INDEX_NONE)
	{
		Result->SetStringField(TEXT("message"), FString::Printf(
			TEXT("Static switch '%s' is not defined on %s or its parent material."),
			*ParameterName,
			*Instance->GetPathName()));
		return SerializeJson(Result);
	}

	FStaticSwitchParameter& Switch = Parameters.StaticSwitchParameters[Index];
	Result->SetBoolField(TEXT("found"), true);
	Result->SetBoolField(TEXT("previous"), Switch.Value);
	Result->SetBoolField(TEXT("previous_overridden"), Switch.bOverride);

	Switch.Value = Value;
	Switch.bOverride = true;

	{
		FMaterialUpdateContext UpdateContext;
		Instance->UpdateStaticPermutation(Parameters, &UpdateContext);
	}

	Instance->MarkPackageDirty();
	Instance->PostEditChange();

	FStaticParameterSet Reapplied;
	Instance->GetStaticParameterValues(Reapplied);
	const int32 ReappliedIndex = FindSwitchIndex(Reapplied, Name);

	Result->SetBoolField(TEXT("success"), true);
	Result->SetBoolField(TEXT("requested"), Value);
	Result->SetBoolField(TEXT("applied"), ReappliedIndex != INDEX_NONE ? Reapplied.StaticSwitchParameters[ReappliedIndex].Value : Value);
	Result->SetBoolField(TEXT("applied_overridden"), ReappliedIndex != INDEX_NONE ? Reapplied.StaticSwitchParameters[ReappliedIndex].bOverride : true);
	Result->SetStringField(TEXT("message"), TEXT("Static switch updated."));
	return SerializeJson(Result);
}

FString UUEVMaterialLibrary::GetMaterialInstanceStaticSwitch(UMaterialInstance* Instance, const FString& ParameterName)
{
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), false);
	Result->SetBoolField(TEXT("found"), false);
	Result->SetStringField(TEXT("parameter"), ParameterName);

	if (!Instance)
	{
		Result->SetStringField(TEXT("message"), TEXT("No material instance was supplied."));
		return SerializeJson(Result);
	}

	const FName Name(*ParameterName);
	if (Name.IsNone())
	{
		Result->SetStringField(TEXT("message"), TEXT("A static switch parameter name is required."));
		return SerializeJson(Result);
	}

	FStaticParameterSet Parameters;
	Instance->GetStaticParameterValues(Parameters);

	const int32 Index = FindSwitchIndex(Parameters, Name);
	if (Index == INDEX_NONE)
	{
		Result->SetStringField(TEXT("message"), FString::Printf(
			TEXT("Static switch '%s' is not defined on %s or its parent material."),
			*ParameterName,
			*Instance->GetPathName()));
		return SerializeJson(Result);
	}

	Result->SetBoolField(TEXT("success"), true);
	Result->SetBoolField(TEXT("found"), true);
	Result->SetBoolField(TEXT("value"), Parameters.StaticSwitchParameters[Index].Value);
	Result->SetBoolField(TEXT("overridden"), Parameters.StaticSwitchParameters[Index].bOverride);
	Result->SetStringField(TEXT("message"), TEXT("OK"));
	return SerializeJson(Result);
}

FString UUEVMaterialLibrary::ListMaterialInstanceStaticSwitches(UMaterialInstance* Instance)
{
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("success"), false);
	Result->SetNumberField(TEXT("count"), 0);

	if (!Instance)
	{
		Result->SetStringField(TEXT("message"), TEXT("No material instance was supplied."));
		return SerializeJson(Result);
	}

	FStaticParameterSet Parameters;
	Instance->GetStaticParameterValues(Parameters);

	TArray<TSharedPtr<FJsonValue>> Switches;
	for (const FStaticSwitchParameter& Switch : Parameters.StaticSwitchParameters)
	{
		const TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
		Entry->SetStringField(TEXT("name"), Switch.ParameterInfo.Name.ToString());
		Entry->SetBoolField(TEXT("value"), Switch.Value);
		Entry->SetBoolField(TEXT("overridden"), Switch.bOverride);
		Switches.Add(MakeShared<FJsonValueObject>(Entry));
	}

	Result->SetBoolField(TEXT("success"), true);
	Result->SetNumberField(TEXT("count"), Switches.Num());
	Result->SetArrayField(TEXT("switches"), Switches);
	Result->SetStringField(TEXT("message"), TEXT("OK"));
	return SerializeJson(Result);
}
