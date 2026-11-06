#pragma once

#include "CoreMinimal.h"
#include "Templates/Function.h"

class FJsonObject;
class IHttpRequest;

struct FUEVControlDescriptor
{
	FString Host = TEXT("127.0.0.1");
	int32 Port = 0;
	FString Token;
	FString Profile = TEXT("unattended");
	bool bReadOnly = false;
	int32 AllowlistVersion = 0;
	FString StartedAt;

	bool IsValid() const
	{
		return Port > 0 && !Token.IsEmpty();
	}
};

struct FUEVParamInfo
{
	FString Name;
	FString Type;
	bool bRequired = false;
	FString Description;
	TArray<FString> EnumValues;
	/** Declared sub-fields of an object parameter (the catalog's `properties` record, sorted by name). Empty for open records. */
	TArray<FUEVParamInfo> Properties;
	/** True when the catalog declared `items` for an array parameter. */
	bool bHasItems = false;
	/** Item descriptor; shared pointer because FUEVParamInfo contains it recursively. */
	TSharedPtr<FUEVParamInfo> Items;
	/** Value descriptor for an open record (the catalog's `additionalProperties`); null for z.record(z.any()). */
	TSharedPtr<FUEVParamInfo> AdditionalProperties;
	/** Distinct shapes the schema accepts, for example object and array for the vector/color shorthands. */
	TArray<FString> Variants;
};

struct FUEVControlAction
{
	FString Name;
	FString Mode;
	bool bAllowed = false;
	FString Reason;
	FString Note;
	FString Undo;
	bool bTransactional = false;
	int32 TimeoutMs = 0;
	/** Mirrors the catalog's supportsDryRun flag; only declared actions may be sent dry_run=true. */
	bool bSupportsDryRun = false;
	TArray<FUEVParamInfo> Params;
};

struct FUEVControlTool
{
	FString Name;
	FString Description;
	FString Kind;
	TArray<FUEVControlAction> Actions;
	bool bHasDirect = false;
	FUEVControlAction Direct;
};

/** Server-level version surface reported alongside the catalog; used by the panel footer and the compatibility banner. */
struct FUEVControlCatalogInfo
{
	bool bLoaded = false;
	FString Version;
	FString ProductVersion;
	FString ServerVersion;
	int32 ProtocolVersion = 0;
	FString Profile;
	bool bReadOnly = false;
	int32 AllowlistVersion = 0;
	FString Error;
};

struct FUEVControlHealth
{
	bool bOk = false;
	FString Version;
	FString ProductVersion;
	FString ServerVersion;
	int32 ProtocolVersion = 0;
	int32 Pid = 0;
	FString StartedAt;
	FString Profile = TEXT("unattended");
	bool bReadOnly = false;
	int32 AllowlistVersion = 0;
	bool bDegraded = false;
	FString SupervisorStatus;
	FString EngineVersion;
	FString EngineBuild;
	bool bEngineReported = false;
	bool bEngineCompatible = false;
	FString EngineReason;
	FString RawJson;
	FString Error;
};

struct FUEVControlCallResult
{
	bool bOk = false;
	bool bAbandoned = false;
	bool bDryRun = false;
	bool bSupportsDryRun = false;
	bool bHasApplied = false;
	bool bApplied = false;
	FString Code;
	FString Note;
	FString Status;
	FString Text;
	FString Error;
	double DurationMs = 0.0;
};

struct FUEVControlHistoryEntry
{
	FString Id;
	FString Timestamp;
	FString Tool;
	FString Action;
	FString Mode;
	FString Status;
	FString ResultSummary;
	FString ArgsPreview;
	FString Undo;
	bool bUndone = false;
	double DurationMs = 0.0;
};

/** One entry of GET /api/calls: a call the control server is still waiting on. */
struct FUEVControlCallInfo
{
	FString Id;
	FString Tool;
	FString Action;
	FString StartedAt;
};

class FUEVControlClient
{
public:
	FUEVControlClient();
	~FUEVControlClient();

	bool LoadDescriptor();

	const FUEVControlDescriptor& GetDescriptor() const { return Descriptor; }
	const FString& GetDescriptorPath() const { return DescriptorPath; }
	const FString& GetLastError() const { return LastError; }
	bool IsConnected() const { return Descriptor.IsValid(); }

	void GetHealth(TFunction<void(const FUEVControlHealth&, bool)> OnComplete);
	void GetCatalog(TFunction<void(const TArray<FUEVControlTool>&, const FUEVControlCatalogInfo&, bool)> OnComplete);
	void GetActiveCalls(TFunction<void(const TArray<FUEVControlCallInfo>&, bool)> OnComplete);
	void CallTool(
		const FString& Tool,
		const FString& Action,
		const TSharedPtr<FJsonObject>& Params,
		TFunction<void(const FUEVControlCallResult&)> OnComplete);
	/** POST /api/cancel: stop waiting for a call. Returns (bOk, note, error); never interrupts the editor operation. */
	void CancelCall(const FString& CallId, TFunction<void(bool, const FString&, const FString&)> OnComplete);
	void GetHistory(int32 Limit, TFunction<void(const TArray<FUEVControlHistoryEntry>&, bool)> OnComplete);
	void Panic(const FString& Reason, TFunction<void(bool, const FString&)> OnComplete);

private:
	void SendJson(
		const FString& Path,
		const FString& Verb,
		const TSharedPtr<FJsonObject>& Body,
		int32 TimeoutSeconds,
		TFunction<void(const TSharedPtr<FJsonObject>&, bool, const FString&)> OnComplete);
	void SetRequestHeaders(IHttpRequest& Request) const;

	FUEVControlDescriptor Descriptor;
	FString DescriptorPath;
	FString LastError;
};
