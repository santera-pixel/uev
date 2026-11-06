#pragma once

#include "CoreMinimal.h"
#include "Engine/DeveloperSettings.h"
#include "UEVControlPanelSettings.generated.h"

UCLASS(config = Editor, defaultconfig, meta = (DisplayName = "UEV Control Panel"))
class UEVCONTROLPANEL_API UUEVControlPanelSettings : public UDeveloperSettings
{
	GENERATED_BODY()

public:
	UUEVControlPanelSettings();

	UPROPERTY(config, EditAnywhere, Category = "Connection", meta = (DisplayName = "Control descriptor path"))
	FString DescriptorPath;

	UPROPERTY(config, EditAnywhere, Category = "Connection", meta = (ClampMin = "1", ClampMax = "600"))
	int32 RequestTimeoutSeconds;

	UPROPERTY(config, EditAnywhere, Category = "Connection", meta = (DisplayName = "Manual token (optional)"))
	FString ManualToken;

	virtual FName GetCategoryName() const override;

	static FString GetDefaultDescriptorPath();
};
