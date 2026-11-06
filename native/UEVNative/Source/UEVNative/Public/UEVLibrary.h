#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "UEVLibrary.generated.h"

UCLASS()
class UEVNATIVE_API UUEVLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	UFUNCTION(BlueprintCallable, Category = "UEV|History")
	static bool BeginTransaction(const FString& Label);

	UFUNCTION(BlueprintCallable, Category = "UEV|History")
	static bool EndTransaction();

	UFUNCTION(BlueprintCallable, Category = "UEV|History")
	static bool CancelTransaction();

	UFUNCTION(BlueprintCallable, Category = "UEV|History")
	static bool Undo();

	UFUNCTION(BlueprintCallable, Category = "UEV|History")
	static bool Redo();

	UFUNCTION(BlueprintCallable, Category = "UEV|Console")
	static FString GetConsoleVariableInfo(const FString& Name);

	UFUNCTION(BlueprintCallable, Category = "UEV|Plugins")
	static TArray<FString> GetEnabledPluginNames();

	UFUNCTION(BlueprintCallable, Category = "UEV|Plugins")
	static bool IsModuleLoaded(const FString& ModuleName);

	UFUNCTION(BlueprintCallable, Category = "UEV|Lifetime")
	static int32 RetainObject(UObject* Object);

	UFUNCTION(BlueprintCallable, Category = "UEV|Lifetime")
	static bool ReleaseObject(UObject* Object);

	UFUNCTION(BlueprintCallable, Category = "UEV|Lifetime")
	static void ReleaseAllRetainedObjects();

	UFUNCTION(BlueprintCallable, Category = "UEV|Lifetime")
	static int32 GetRetainedObjectCount();

	UFUNCTION(BlueprintCallable, Category = "UEV|Lifetime")
	static UObject* GetRetainedObject(int32 Index);
};
