#pragma once

#include "CoreMinimal.h"
#include "HAL/IConsoleManager.h"
#include "HAL/PlatformProcess.h"
#include "Modules/ModuleManager.h"

class SDockTab;
class FSpawnTabArgs;

class FUEVControlPanelModule : public IModuleInterface
{
public:
	virtual void StartupModule() override;
	virtual void ShutdownModule() override;

	bool StartControlServer(FString& OutError);
	void StopControlServer();
	bool IsControlServerOwned() const;
	bool IsControlServerRunning();

private:
	TSharedRef<SDockTab> SpawnControlPanelTab(const FSpawnTabArgs& Args);
	void OpenControlPanel();

	TUniquePtr<class FAutoConsoleCommand> OpenCommand;
	TUniquePtr<class FAutoConsoleCommand> DockCommand;
	TUniquePtr<class FAutoConsoleCommand> StartControlCommand;
	TUniquePtr<class FAutoConsoleCommand> StopControlCommand;
	FProcHandle ControlServerProcess;
	uint32 ControlServerProcessId = 0;
	bool bControlServerStartedByPanel = false;
};
