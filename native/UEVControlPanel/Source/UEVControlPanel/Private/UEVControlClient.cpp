#include "UEVControlClient.h"

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "UEVControlPanelSettings.h"
#include "Misc/FileHelper.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

namespace
{
	TSharedPtr<FJsonObject> ParseJsonObject(const FString& Text)
	{
		TSharedPtr<FJsonObject> Object;
		const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Text);
		if (!FJsonSerializer::Deserialize(Reader, Object))
		{
			return nullptr;
		}
		return Object;
	}

	FUEVParamInfo ParseParamObject(const TSharedPtr<FJsonObject>& ParamJson, const FString& FallbackName)
	{
		FUEVParamInfo Param;
		if (!ParamJson.IsValid())
		{
			return Param;
		}

		ParamJson->TryGetStringField(TEXT("name"), Param.Name);
		if (Param.Name.IsEmpty())
		{
			Param.Name = FallbackName;
		}
		ParamJson->TryGetStringField(TEXT("type"), Param.Type);
		ParamJson->TryGetBoolField(TEXT("required"), Param.bRequired);
		ParamJson->TryGetStringField(TEXT("description"), Param.Description);

		const TArray<TSharedPtr<FJsonValue>>* EnumValues = nullptr;
		if (ParamJson->TryGetArrayField(TEXT("enum"), EnumValues) && EnumValues)
		{
			for (const TSharedPtr<FJsonValue>& EnumValue : *EnumValues)
			{
				Param.EnumValues.Add(EnumValue->AsString());
			}
		}

		const TSharedPtr<FJsonObject>* PropertiesJson = nullptr;
		if (ParamJson->TryGetObjectField(TEXT("properties"), PropertiesJson) && PropertiesJson && (*PropertiesJson).IsValid())
		{
			TArray<FString> PropertyNames;
			for (const TPair<FString, TSharedPtr<FJsonValue>>& Pair : (*PropertiesJson)->Values)
			{
				PropertyNames.Add(Pair.Key);
			}
			PropertyNames.Sort();
			for (const FString& PropertyName : PropertyNames)
			{
				const TSharedPtr<FJsonValue> PropertyValue = (*PropertiesJson)->TryGetField(PropertyName);
				const TSharedPtr<FJsonObject> PropertyJson = PropertyValue.IsValid() ? PropertyValue->AsObject() : nullptr;
				if (PropertyJson.IsValid())
				{
					Param.Properties.Add(ParseParamObject(PropertyJson, PropertyName));
				}
			}
		}

		const TSharedPtr<FJsonObject>* ItemsJson = nullptr;
		if (ParamJson->TryGetObjectField(TEXT("items"), ItemsJson) && ItemsJson && (*ItemsJson).IsValid())
		{
			Param.bHasItems = true;
			Param.Items = MakeShared<FUEVParamInfo>(ParseParamObject(*ItemsJson, TEXT("item")));
		}

		const TSharedPtr<FJsonObject>* AdditionalPropertiesJson = nullptr;
		if (ParamJson->TryGetObjectField(TEXT("additionalProperties"), AdditionalPropertiesJson) && AdditionalPropertiesJson &&
			(*AdditionalPropertiesJson).IsValid())
		{
			Param.AdditionalProperties =
				MakeShared<FUEVParamInfo>(ParseParamObject(*AdditionalPropertiesJson, TEXT("value")));
		}

		const TArray<TSharedPtr<FJsonValue>>* VariantValues = nullptr;
		if (ParamJson->TryGetArrayField(TEXT("variants"), VariantValues) && VariantValues)
		{
			for (const TSharedPtr<FJsonValue>& VariantValue : *VariantValues)
			{
				if (VariantValue.IsValid() && VariantValue->Type == EJson::String)
				{
					Param.Variants.Add(VariantValue->AsString());
				}
			}
		}

		return Param;
	}

	FUEVControlAction ParseAction(const TSharedPtr<FJsonObject>& Object)
	{
		FUEVControlAction Action;
		if (!Object.IsValid())
		{
			return Action;
		}

		Object->TryGetStringField(TEXT("name"), Action.Name);
		Object->TryGetStringField(TEXT("mode"), Action.Mode);
		Object->TryGetBoolField(TEXT("allowed"), Action.bAllowed);
		Object->TryGetStringField(TEXT("reason"), Action.Reason);
		Object->TryGetStringField(TEXT("note"), Action.Note);
		Object->TryGetStringField(TEXT("undo"), Action.Undo);
		Object->TryGetBoolField(TEXT("transactional"), Action.bTransactional);
		Object->TryGetBoolField(TEXT("supportsDryRun"), Action.bSupportsDryRun);
		Object->TryGetNumberField(TEXT("timeoutMs"), Action.TimeoutMs);

		const TArray<TSharedPtr<FJsonValue>>* ParamValues = nullptr;
		if (Object->TryGetArrayField(TEXT("params"), ParamValues) && ParamValues)
		{
			for (const TSharedPtr<FJsonValue>& ParamValue : *ParamValues)
			{
				const TSharedPtr<FJsonObject> ParamJson = ParamValue->AsObject();
				if (!ParamJson.IsValid())
				{
					continue;
				}

				const FUEVParamInfo Param = ParseParamObject(ParamJson, FString());
				if (!Param.Name.IsEmpty())
				{
					Action.Params.Add(Param);
				}
			}
		}

		return Action;
	}
}

FUEVControlClient::FUEVControlClient() = default;
FUEVControlClient::~FUEVControlClient() = default;

bool FUEVControlClient::LoadDescriptor()
{
	LastError.Empty();
	Descriptor = FUEVControlDescriptor();

	const UUEVControlPanelSettings* Settings = GetDefault<UUEVControlPanelSettings>();
	DescriptorPath = Settings->DescriptorPath.IsEmpty()
		? UUEVControlPanelSettings::GetDefaultDescriptorPath()
		: Settings->DescriptorPath;

	FString DescriptorText;
	if (!FFileHelper::LoadFileToString(DescriptorText, *DescriptorPath))
	{
		LastError = FString::Printf(TEXT("Control descriptor not found: %s"), *DescriptorPath);
		return false;
	}

	const TSharedPtr<FJsonObject> Json = ParseJsonObject(DescriptorText);
	if (!Json.IsValid())
	{
		LastError = FString::Printf(TEXT("Invalid control descriptor JSON: %s"), *DescriptorPath);
		return false;
	}

	Json->TryGetStringField(TEXT("host"), Descriptor.Host);
	if (Descriptor.Host.IsEmpty())
	{
		Descriptor.Host = TEXT("127.0.0.1");
	}
	Json->TryGetNumberField(TEXT("port"), Descriptor.Port);
	Json->TryGetStringField(TEXT("token"), Descriptor.Token);
	Json->TryGetStringField(TEXT("profile"), Descriptor.Profile);
	Json->TryGetBoolField(TEXT("readOnly"), Descriptor.bReadOnly);
	Json->TryGetNumberField(TEXT("allowlistVersion"), Descriptor.AllowlistVersion);
	Json->TryGetStringField(TEXT("startedAt"), Descriptor.StartedAt);

	if (!Settings->ManualToken.IsEmpty())
	{
		Descriptor.Token = Settings->ManualToken;
	}

	if (!Descriptor.IsValid())
	{
		LastError = FString::Printf(TEXT("Control descriptor has no port or token: %s"), *DescriptorPath);
		return false;
	}

	return true;
}

void FUEVControlClient::SetRequestHeaders(IHttpRequest& Request) const
{
	Request.SetHeader(TEXT("Authorization"), FString::Printf(TEXT("Bearer %s"), *Descriptor.Token));
	Request.SetHeader(TEXT("Accept"), TEXT("application/json"));
}

void FUEVControlClient::SendJson(
	const FString& Path,
	const FString& Verb,
	const TSharedPtr<FJsonObject>& Body,
	const int32 TimeoutSeconds,
	TFunction<void(const TSharedPtr<FJsonObject>&, bool, const FString&)> OnComplete)
{
	if (!IsConnected())
	{
		OnComplete(TSharedPtr<FJsonObject>(), false, LastError.IsEmpty() ? TEXT("Control API is offline.") : LastError);
		return;
	}

	const TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(FString::Printf(TEXT("http://%s:%d%s"), *Descriptor.Host, Descriptor.Port, *Path));
	Request->SetVerb(Verb);
	Request->SetTimeout(static_cast<float>(FMath::Max(1, TimeoutSeconds)));
	SetRequestHeaders(*Request);

	if (Body.IsValid())
	{
		FString BodyText;
		const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&BodyText);
		FJsonSerializer::Serialize(Body.ToSharedRef(), Writer);
		Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
		Request->SetContentAsString(BodyText);
	}

	Request->OnProcessRequestComplete().BindLambda(
		[OnComplete](FHttpRequestPtr, const FHttpResponsePtr Response, const bool bConnectedSuccessfully)
		{
			if (!bConnectedSuccessfully || !Response.IsValid())
			{
				OnComplete(TSharedPtr<FJsonObject>(), false, TEXT("Control API request failed."));
				return;
			}

			const int32 ResponseCode = Response->GetResponseCode();
			const FString ResponseText = Response->GetContentAsString();
			const TSharedPtr<FJsonObject> Json = ParseJsonObject(ResponseText);

			if (ResponseCode < 200 || ResponseCode >= 300)
			{
				FString Error;
				if (Json.IsValid())
				{
					Json->TryGetStringField(TEXT("error"), Error);
				}
				OnComplete(Json, false, Error.IsEmpty() ? FString::Printf(TEXT("HTTP %d"), ResponseCode) : Error);
				return;
			}

			if (!Json.IsValid())
			{
				OnComplete(nullptr, false, FString::Printf(TEXT("Invalid JSON response (HTTP %d)."), ResponseCode));
				return;
			}

			OnComplete(Json, true, FString());
		});

	Request->ProcessRequest();
}

void FUEVControlClient::GetHealth(TFunction<void(const FUEVControlHealth&, bool)> OnComplete)
{
	SendJson(
		TEXT("/api/health"),
		TEXT("GET"),
		TSharedPtr<FJsonObject>(),
		10,
		[OnComplete](const TSharedPtr<FJsonObject>& Json, const bool bOk, const FString& Error)
		{
			FUEVControlHealth Health;
			Health.Error = Error;
			if (Json.IsValid())
			{
				Json->TryGetBoolField(TEXT("ok"), Health.bOk);
				Json->TryGetStringField(TEXT("version"), Health.Version);
				Json->TryGetNumberField(TEXT("pid"), Health.Pid);
				Json->TryGetStringField(TEXT("startedAt"), Health.StartedAt);
				Json->TryGetStringField(TEXT("profile"), Health.Profile);
				Json->TryGetBoolField(TEXT("readOnly"), Health.bReadOnly);
				Json->TryGetNumberField(TEXT("allowlistVersion"), Health.AllowlistVersion);
				Json->TryGetBoolField(TEXT("degraded"), Health.bDegraded);
				Json->TryGetStringField(TEXT("productVersion"), Health.ProductVersion);
				Json->TryGetStringField(TEXT("serverVersion"), Health.ServerVersion);
				Json->TryGetNumberField(TEXT("protocolVersion"), Health.ProtocolVersion);

				const TSharedPtr<FJsonObject>* Supervisor = nullptr;
				if (Json->TryGetObjectField(TEXT("supervisor"), Supervisor) && Supervisor && Supervisor->IsValid())
				{
					bool bConnected = false;
					(*Supervisor)->TryGetBoolField(TEXT("connected"), bConnected);
					Health.SupervisorStatus = bConnected ? TEXT("connected") : TEXT("offline");
				}
				else
				{
					Health.SupervisorStatus = TEXT("unknown");
				}

				const TSharedPtr<FJsonObject>* IdentityJson = nullptr;
				if (Json->TryGetObjectField(TEXT("engineIdentity"), IdentityJson) && IdentityJson && (*IdentityJson).IsValid())
				{
					Health.bEngineReported = true;
					(*IdentityJson)->TryGetStringField(TEXT("version"), Health.EngineVersion);
					(*IdentityJson)->TryGetStringField(TEXT("build"), Health.EngineBuild);
					(*IdentityJson)->TryGetBoolField(TEXT("compatible"), Health.bEngineCompatible);
					(*IdentityJson)->TryGetStringField(TEXT("reason"), Health.EngineReason);
				}
			}

			OnComplete(Health, bOk && Health.bOk);
		});
}

void FUEVControlClient::GetCatalog(
	TFunction<void(const TArray<FUEVControlTool>&, const FUEVControlCatalogInfo&, bool)> OnComplete)
{
	SendJson(
		TEXT("/api/catalog"),
		TEXT("GET"),
		TSharedPtr<FJsonObject>(),
		15,
		[OnComplete](const TSharedPtr<FJsonObject>& Json, const bool bOk, const FString& Error)
		{
			TArray<FUEVControlTool> Tools;
			FUEVControlCatalogInfo Info;
			Info.Error = Error;
			if (Json.IsValid())
			{
				Json->TryGetStringField(TEXT("version"), Info.Version);
				Json->TryGetStringField(TEXT("productVersion"), Info.ProductVersion);
				Json->TryGetStringField(TEXT("serverVersion"), Info.ServerVersion);
				Json->TryGetNumberField(TEXT("protocolVersion"), Info.ProtocolVersion);
				Json->TryGetStringField(TEXT("profile"), Info.Profile);
				Json->TryGetBoolField(TEXT("readOnly"), Info.bReadOnly);
				Json->TryGetNumberField(TEXT("allowlistVersion"), Info.AllowlistVersion);
				Info.bLoaded = bOk;

				const TArray<TSharedPtr<FJsonValue>>* ToolValues = nullptr;
				if (Json->TryGetArrayField(TEXT("tools"), ToolValues) && ToolValues)
				{
					for (const TSharedPtr<FJsonValue>& ToolValue : *ToolValues)
					{
						const TSharedPtr<FJsonObject> ToolJson = ToolValue->AsObject();
						if (!ToolJson.IsValid())
						{
							continue;
						}

						FUEVControlTool Tool;
						ToolJson->TryGetStringField(TEXT("name"), Tool.Name);
						ToolJson->TryGetStringField(TEXT("description"), Tool.Description);
						ToolJson->TryGetStringField(TEXT("kind"), Tool.Kind);

						const TArray<TSharedPtr<FJsonValue>>* ActionValues = nullptr;
						if (ToolJson->TryGetArrayField(TEXT("actions"), ActionValues) && ActionValues)
						{
							for (const TSharedPtr<FJsonValue>& ActionValue : *ActionValues)
							{
								const TSharedPtr<FJsonObject> ActionJson = ActionValue->AsObject();
								if (ActionJson.IsValid())
								{
									Tool.Actions.Add(ParseAction(ActionJson));
								}
							}
						}

						const TSharedPtr<FJsonObject>* DirectJson = nullptr;
						if (ToolJson->TryGetObjectField(TEXT("direct"), DirectJson) && DirectJson && DirectJson->IsValid())
						{
							Tool.bHasDirect = true;
							Tool.Direct = ParseAction(*DirectJson);
						}

						Tools.Add(Tool);
					}
				}
			}

			OnComplete(Tools, Info, bOk);
		});
}

void FUEVControlClient::CallTool(
	const FString& Tool,
	const FString& Action,
	const TSharedPtr<FJsonObject>& Params,
	TFunction<void(const FUEVControlCallResult&)> OnComplete)
{
	TSharedPtr<FJsonObject> Body = MakeShared<FJsonObject>();
	Body->SetStringField(TEXT("tool"), Tool);
	if (!Action.IsEmpty())
	{
		Body->SetStringField(TEXT("action"), Action);
	}
	Body->SetObjectField(TEXT("params"), Params.IsValid() ? Params : MakeShared<FJsonObject>());

	const UUEVControlPanelSettings* Settings = GetDefault<UUEVControlPanelSettings>();
	SendJson(
		TEXT("/api/call"),
		TEXT("POST"),
		Body,
		Settings->RequestTimeoutSeconds,
		[OnComplete](const TSharedPtr<FJsonObject>& Json, const bool bOk, const FString& Error)
		{
			FUEVControlCallResult Result;
			Result.bOk = bOk;
			Result.Error = Error;

			if (Json.IsValid())
			{
				Json->TryGetStringField(TEXT("text"), Result.Text);
				Json->TryGetBoolField(TEXT("abandoned"), Result.bAbandoned);
				Json->TryGetBoolField(TEXT("dryRun"), Result.bDryRun);
				Json->TryGetBoolField(TEXT("supportsDryRun"), Result.bSupportsDryRun);
				Json->TryGetStringField(TEXT("status"), Result.Status);
				Json->TryGetStringField(TEXT("note"), Result.Note);
				Json->TryGetStringField(TEXT("code"), Result.Code);
				if (Json->TryGetBoolField(TEXT("applied"), Result.bApplied))
				{
					Result.bHasApplied = true;
				}

				FString JsonError;
				if (Json->TryGetStringField(TEXT("error"), JsonError) && !JsonError.IsEmpty())
				{
					Result.Error = JsonError;
				}

				double DurationMs = 0.0;
				if (Json->TryGetNumberField(TEXT("durationMs"), DurationMs))
				{
					Result.DurationMs = DurationMs;
				}

				bool bJsonOk = true;
				if (Json->TryGetBoolField(TEXT("ok"), bJsonOk))
				{
					Result.bOk = bOk && bJsonOk;
				}
			}

			OnComplete(Result);
		});
}

void FUEVControlClient::GetHistory(
	const int32 Limit,
	TFunction<void(const TArray<FUEVControlHistoryEntry>&, bool)> OnComplete)
{
	SendJson(
		FString::Printf(TEXT("/api/history?limit=%d"), FMath::Clamp(Limit, 1, 200)),
		TEXT("GET"),
		TSharedPtr<FJsonObject>(),
		15,
		[OnComplete](const TSharedPtr<FJsonObject>& Json, const bool bOk, const FString& Error)
		{
			TArray<FUEVControlHistoryEntry> Entries;
			if (Json.IsValid())
			{
				const TArray<TSharedPtr<FJsonValue>>* EntryValues = nullptr;
				if (Json->TryGetArrayField(TEXT("entries"), EntryValues) && EntryValues)
				{
					for (const TSharedPtr<FJsonValue>& EntryValue : *EntryValues)
					{
						const TSharedPtr<FJsonObject> EntryJson = EntryValue->AsObject();
						if (!EntryJson.IsValid())
						{
							continue;
						}

						FUEVControlHistoryEntry Entry;
						EntryJson->TryGetStringField(TEXT("id"), Entry.Id);
						EntryJson->TryGetStringField(TEXT("timestamp"), Entry.Timestamp);
						EntryJson->TryGetStringField(TEXT("tool"), Entry.Tool);
						EntryJson->TryGetStringField(TEXT("action"), Entry.Action);
						EntryJson->TryGetStringField(TEXT("mode"), Entry.Mode);
						EntryJson->TryGetStringField(TEXT("status"), Entry.Status);
						EntryJson->TryGetStringField(TEXT("resultSummary"), Entry.ResultSummary);
						EntryJson->TryGetStringField(TEXT("argsPreview"), Entry.ArgsPreview);
						EntryJson->TryGetStringField(TEXT("undo"), Entry.Undo);
						EntryJson->TryGetBoolField(TEXT("undone"), Entry.bUndone);

						double DurationMs = 0.0;
						if (EntryJson->TryGetNumberField(TEXT("durationMs"), DurationMs))
						{
							Entry.DurationMs = DurationMs;
						}

						Entries.Add(Entry);
					}
				}
			}

			OnComplete(Entries, bOk);
		});
}

void FUEVControlClient::GetActiveCalls(TFunction<void(const TArray<FUEVControlCallInfo>&, bool)> OnComplete)
{
	SendJson(
		TEXT("/api/calls"),
		TEXT("GET"),
		TSharedPtr<FJsonObject>(),
		10,
		[OnComplete](const TSharedPtr<FJsonObject>& Json, const bool bOk, const FString&)
		{
			TArray<FUEVControlCallInfo> Calls;
			if (Json.IsValid())
			{
				const TArray<TSharedPtr<FJsonValue>>* CallValues = nullptr;
				if (Json->TryGetArrayField(TEXT("calls"), CallValues) && CallValues)
				{
					for (const TSharedPtr<FJsonValue>& CallValue : *CallValues)
					{
						const TSharedPtr<FJsonObject> CallJson = CallValue->AsObject();
						if (!CallJson.IsValid())
						{
							continue;
						}

						FUEVControlCallInfo Call;
						CallJson->TryGetStringField(TEXT("id"), Call.Id);
						CallJson->TryGetStringField(TEXT("tool"), Call.Tool);
						CallJson->TryGetStringField(TEXT("action"), Call.Action);
						CallJson->TryGetStringField(TEXT("startedAt"), Call.StartedAt);
						if (!Call.Id.IsEmpty())
						{
							Calls.Add(Call);
						}
					}
				}
			}

			OnComplete(Calls, bOk);
		});
}

void FUEVControlClient::CancelCall(
	const FString& CallId,
	TFunction<void(bool, const FString&, const FString&)> OnComplete)
{
	TSharedPtr<FJsonObject> Body = MakeShared<FJsonObject>();
	Body->SetStringField(TEXT("callId"), CallId);

	SendJson(
		TEXT("/api/cancel"),
		TEXT("POST"),
		Body,
		10,
		[OnComplete](const TSharedPtr<FJsonObject>& Json, const bool bOk, const FString& Error)
		{
			FString Note;
			if (Json.IsValid())
			{
				Json->TryGetStringField(TEXT("note"), Note);
			}

			OnComplete(bOk, Note, Error);
		});
}

void FUEVControlClient::Panic(const FString& Reason, TFunction<void(bool, const FString&)> OnComplete)
{
	TSharedPtr<FJsonObject> Body = MakeShared<FJsonObject>();
	Body->SetStringField(TEXT("reason"), Reason);

	SendJson(
		TEXT("/api/panic"),
		TEXT("POST"),
		Body,
		10,
		[OnComplete](const TSharedPtr<FJsonObject>& Json, const bool bOk, const FString& Error)
		{
			FString Message = Error;
			if (Json.IsValid())
			{
				FString JsonMessage;
				if (Json->TryGetStringField(TEXT("message"), JsonMessage))
				{
					Message = JsonMessage;
				}
			}

			OnComplete(bOk, Message);
		});
}
