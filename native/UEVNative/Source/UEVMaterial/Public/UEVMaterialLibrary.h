#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "UEVMaterialLibrary.generated.h"

/**
 * Editor-only material instance parameter edits that the engine's Python surface does not expose.
 *
 * UE 4.27's MaterialEditingLibrary can read static switch values from a MaterialInstanceConstant but
 * has no setter for them (UMaterialInstanceConstant only carries EditorOnly setters for scalar, vector,
 * texture, font and virtual-texture parameters). These helpers fill that gap by rewriting the instance's
 * FStaticParameterSet and rebuilding its static permutation.
 *
 * Results are returned as JSON strings so the Python side can read a single value instead of dealing
 * with by-ref out parameters.
 */
UCLASS()
class UEVMATERIAL_API UUEVMaterialLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	/** JSON {success, found, parameter, previous, previous_overridden, applied, applied_overridden, message}. */
	UFUNCTION(BlueprintCallable, Category = "UEV|Material")
	static FString SetMaterialInstanceStaticSwitch(UMaterialInstance* Instance, const FString& ParameterName, bool Value);

	/** JSON {success, found, parameter, value, overridden, message}. */
	UFUNCTION(BlueprintCallable, Category = "UEV|Material")
	static FString GetMaterialInstanceStaticSwitch(UMaterialInstance* Instance, const FString& ParameterName);

	/** JSON {success, count, switches:[{name, value, overridden}], message} for every static switch. */
	UFUNCTION(BlueprintCallable, Category = "UEV|Material")
	static FString ListMaterialInstanceStaticSwitches(UMaterialInstance* Instance);
};
