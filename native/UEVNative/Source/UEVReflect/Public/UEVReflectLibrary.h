#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "UEVReflectLibrary.generated.h"

/**
 * Reflection substrate for the UEV server.
 *
 * Everything here is deliberately text-based: values are exchanged in the editor's own
 * ExportText/ImportText format so structs, arrays, maps, enums and object references all
 * round-trip without a bespoke JSON type mapping.
 */
UCLASS()
class UEVREFLECT_API UUEVReflectLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	/** Resolve a class from "/Script/Engine.PointLight", "Engine.PointLight", or "PointLight". */
	UFUNCTION(BlueprintCallable, Category = "UEV|Reflect")
	static UClass* ResolveClass(const FString& ClassName);

	/** JSON class schema: properties with type, enum values, clamp range, editability; optionally functions. */
	UFUNCTION(BlueprintCallable, Category = "UEV|Reflect")
	static FString DescribeClass(UClass* Class, bool bIncludeFunctions);

	/** JSON instance description: compact summary plus, optionally, current property values. */
	UFUNCTION(BlueprintCallable, Category = "UEV|Reflect")
	static FString DescribeObject(UObject* Object, bool bIncludeValues);

	/** Read a property path such as "RelativeLocation.X", "Materials[0]" or "Tags". JSON result. */
	UFUNCTION(BlueprintCallable, Category = "UEV|Reflect")
	static FString GetProperty(UObject* Object, const FString& Path);

	/** Write a property path from editor text form. Returns empty string on success, error text otherwise. */
	UFUNCTION(BlueprintCallable, Category = "UEV|Reflect")
	static FString SetProperty(UObject* Object, const FString& Path, const FString& ValueText);

	/** Call a UFUNCTION with arguments supplied in editor text form, positionally. JSON result. */
	UFUNCTION(BlueprintCallable, Category = "UEV|Reflect")
	static FString CallFunction(UObject* Object, const FString& FunctionName, const TArray<FString>& Arguments);

	/** Mark objects (and their components) modified inside the caller's transaction. */
	UFUNCTION(BlueprintCallable, Category = "UEV|Reflect")
	static bool MarkModified(const TArray<UObject*>& Objects);

	/** JSON description of one function: return type and parameter list. */
	UFUNCTION(BlueprintCallable, Category = "UEV|Reflect")
	static FString DescribeFunction(UFunction* Function);
};
