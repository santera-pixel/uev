#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "UEVInputLibrary.generated.h"

class APlayerController;

UCLASS()
class UEVNATIVE_API UUEVInputLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	UFUNCTION(BlueprintCallable, Category = "UEV|Input")
	static bool StartPIEPlay();

	UFUNCTION(BlueprintCallable, Category = "UEV|Input")
	static bool InjectKey(const FString& KeyName, bool bPressed);

	UFUNCTION(BlueprintCallable, Category = "UEV|Input")
	static bool InjectMouseButton(const FString& ButtonName, bool bPressed);

	UFUNCTION(BlueprintCallable, Category = "UEV|Input")
	static bool InjectMouseMove(float DeltaX, float DeltaY);

	UFUNCTION(BlueprintCallable, Category = "UEV|Input")
	static APlayerController* GetPIEPlayerController();
};
