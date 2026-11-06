#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "UEVGraphLibrary.generated.h"

UCLASS()
class UEVGRAPHAUTHORING_API UUEVGraphLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	UFUNCTION(BlueprintCallable, Category = "UEV|Graph")
	static FString ExecuteGraphOperation(const FString& Operation, const FString& ArgsJson);
};
