#include "UEVControlPanelSettings.h"

#include "HAL/FileManager.h"
#include "Misc/Paths.h"

UUEVControlPanelSettings::UUEVControlPanelSettings()
	: RequestTimeoutSeconds(120)
{
	DescriptorPath = GetDefaultDescriptorPath();
}

FName UUEVControlPanelSettings::GetCategoryName() const
{
	return TEXT("Plugins");
}

FString UUEVControlPanelSettings::GetDefaultDescriptorPath()
{
	const FString LocalAppData = FPlatformMisc::GetEnvironmentVariable(TEXT("LOCALAPPDATA"));
	if (!LocalAppData.IsEmpty())
	{
		return FPaths::Combine(LocalAppData, TEXT("UEV"), TEXT("control.json"));
	}

	return FPaths::Combine(FString(FPlatformProcess::UserSettingsDir()), TEXT("UEV"), TEXT("control.json"));
}
