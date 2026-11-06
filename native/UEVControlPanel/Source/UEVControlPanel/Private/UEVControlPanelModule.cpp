#include "UEVControlPanelModule.h"

#include "Dom/JsonObject.h"
#include "Framework/Docking/TabManager.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformMisc.h"
#include "LevelEditor.h"
#include "UEVControlPanelSettings.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/ScopeExit.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "SUEVControlPanel.h"
#include "Widgets/Docking/SDockTab.h"
#include "WorkspaceMenuStructure.h"
#include "WorkspaceMenuStructureModule.h"

#define LOCTEXT_NAMESPACE "FUEVControlPanelModule"

namespace
{
	const FName UEVControlPanelTabName(TEXT("UEVControlPanel"));
}

void FUEVControlPanelModule::StartupModule()
{
	FGlobalTabmanager::Get()
		->RegisterNomadTabSpawner(
			UEVControlPanelTabName,
			FOnSpawnTab::CreateRaw(this, &FUEVControlPanelModule::SpawnControlPanelTab))
		.SetDisplayName(LOCTEXT("UEVControlPanelTabTitle", "UEV Control Panel"))
		.SetTooltipText(LOCTEXT("UEVControlPanelTabTooltip", "Run and inspect UEV actions."))
		.SetGroup(WorkspaceMenu::GetMenuStructure().GetToolsCategory())
		.SetMenuType(ETabSpawnerMenuType::Enabled);

	OpenCommand = MakeUnique<FAutoConsoleCommand>(
		TEXT("UEV.ControlPanel"),
		TEXT("Open the UEV Control Panel tab."),
		FConsoleCommandDelegate::CreateRaw(this, &FUEVControlPanelModule::OpenControlPanel));

	DockCommand = MakeUnique<FAutoConsoleCommand>(
		TEXT("UEV.DockControlPanel"),
		TEXT("Open the UEV Control Panel."),
		FConsoleCommandDelegate::CreateLambda([this]() { OpenControlPanel(); }));

	StartControlCommand = MakeUnique<FAutoConsoleCommand>(
		TEXT("UEV.StartControl"),
		TEXT("Start the local UEV control API for the open editor."),
		FConsoleCommandDelegate::CreateLambda([this]()
		{
			FString Error;
			if (!StartControlServer(Error))
			{
				UE_LOG(LogTemp, Warning, TEXT("UEV.StartControl: %s"), *Error);
			}
		}));

	StopControlCommand = MakeUnique<FAutoConsoleCommand>(
		TEXT("UEV.StopControl"),
		TEXT("Stop the UEV control API started by the control panel."),
		FConsoleCommandDelegate::CreateLambda([this]() { StopControlServer(); }));
}

void FUEVControlPanelModule::ShutdownModule()
{
	StopControlServer();
	StopControlCommand.Reset();
	StartControlCommand.Reset();
	DockCommand.Reset();
	OpenCommand.Reset();

	FGlobalTabmanager::Get()->UnregisterNomadTabSpawner(UEVControlPanelTabName);
}

bool FUEVControlPanelModule::IsControlServerOwned() const
{
	return bControlServerStartedByPanel;
}

bool FUEVControlPanelModule::IsControlServerRunning()
{
	return bControlServerStartedByPanel
		&& ControlServerProcess.IsValid()
		&& FPlatformProcess::IsProcRunning(ControlServerProcess);
}

bool FUEVControlPanelModule::StartControlServer(FString& OutError)
{
	OutError.Empty();
	if (IsControlServerRunning())
	{
		return true;
	}
	if (bControlServerStartedByPanel)
	{
		StopControlServer();
	}

	const UUEVControlPanelSettings* Settings = GetDefault<UUEVControlPanelSettings>();
	FString DescriptorPath = Settings->DescriptorPath;
	if (DescriptorPath.IsEmpty())
	{
		DescriptorPath = UUEVControlPanelSettings::GetDefaultDescriptorPath();
	}

	FString InstallRoot = FPaths::GetPath(DescriptorPath);
	if (InstallRoot.IsEmpty())
	{
		const FString LocalAppData = FPlatformMisc::GetEnvironmentVariable(TEXT("LOCALAPPDATA"));
		InstallRoot = FPaths::Combine(LocalAppData, TEXT("UEV"));
	}

	const FString NodePath = FPaths::Combine(InstallRoot, TEXT("node"), TEXT("node.exe"));
	const FString EntryPath = FPaths::Combine(InstallRoot, TEXT("app"), TEXT("dist"), TEXT("bin.js"));
	const FString WorkingDirectory = FPaths::Combine(InstallRoot, TEXT("app"), TEXT("dist"));

	if (!IFileManager::Get().FileExists(*NodePath))
	{
		OutError = FString::Printf(TEXT("Bundled Node runtime not found: %s. Run install.bat for this installation."), *NodePath);
		return false;
	}
	if (!IFileManager::Get().FileExists(*EntryPath))
	{
		OutError = FString::Printf(TEXT("UEV server entry not found: %s. Run install.bat for this installation."), *EntryPath);
		return false;
	}
	if (!IFileManager::Get().DirectoryExists(*WorkingDirectory))
	{
		OutError = FString::Printf(TEXT("UEV server directory not found: %s."), *WorkingDirectory);
		return false;
	}

	TArray<TPair<FString, FString>> SavedEnvironment;
	auto SetTemporaryEnvironment = [&SavedEnvironment](const TCHAR* Name, const FString& Value)
	{
		SavedEnvironment.Emplace(Name, FPlatformMisc::GetEnvironmentVariable(Name));
		FPlatformMisc::SetEnvironmentVar(Name, *Value);
	};
	ON_SCOPE_EXIT
	{
		for (const TPair<FString, FString>& Saved : SavedEnvironment)
		{
			FPlatformMisc::SetEnvironmentVar(*Saved.Key, *Saved.Value);
		}
	};

	SetTemporaryEnvironment(TEXT("UEV_PROFILE"), TEXT("supervised"));
	SetTemporaryEnvironment(TEXT("UEV_BIND_ADDRESS"), TEXT("127.0.0.1"));
	SetTemporaryEnvironment(TEXT("UEV_COMMAND_ADDRESS"), TEXT("127.0.0.1"));
	SetTemporaryEnvironment(TEXT("UEV_MULTICAST_TTL"), TEXT("0"));
	SetTemporaryEnvironment(TEXT("UEV_SUPERVISOR"), TEXT("0"));
	SetTemporaryEnvironment(TEXT("UEV_CONTROL_PORT"), TEXT("8765"));
	SetTemporaryEnvironment(TEXT("UEV_CONTROL_DESCRIPTOR"), DescriptorPath);

	const FString Arguments = FString::Printf(TEXT("\"%s\" --control"), *EntryPath);
	uint32 ProcessId = 0;
	FProcHandle Handle = FPlatformProcess::CreateProc(
		*NodePath,
		*Arguments,
		false,
		true,
		true,
		&ProcessId,
		0,
		*WorkingDirectory,
		nullptr,
		nullptr);

	if (!Handle.IsValid())
	{
		OutError = FString::Printf(TEXT("Could not start the UEV control API using %s."), *NodePath);
		return false;
	}

	ControlServerProcess = Handle;
	ControlServerProcessId = ProcessId;
	bControlServerStartedByPanel = true;
	UE_LOG(LogTemp, Display, TEXT("UEV control server started pid=%u node=%s"), ProcessId, *NodePath);
	return true;
}

void FUEVControlPanelModule::StopControlServer()
{
	if (!bControlServerStartedByPanel)
	{
		return;
	}

	const uint32 StoppedProcessId = ControlServerProcessId;
	if (ControlServerProcess.IsValid())
	{
		if (FPlatformProcess::IsProcRunning(ControlServerProcess))
		{
			FPlatformProcess::TerminateProc(ControlServerProcess, true);
		}
		FPlatformProcess::CloseProc(ControlServerProcess);
	}
	ControlServerProcess = FProcHandle();
	ControlServerProcessId = 0;
	bControlServerStartedByPanel = false;

	const UUEVControlPanelSettings* Settings = GetDefault<UUEVControlPanelSettings>();
	FString DescriptorPath = Settings->DescriptorPath;
	if (DescriptorPath.IsEmpty())
	{
		DescriptorPath = UUEVControlPanelSettings::GetDefaultDescriptorPath();
	}

	FString DescriptorText;
	if (FFileHelper::LoadFileToString(DescriptorText, *DescriptorPath))
	{
		const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(DescriptorText);
		TSharedPtr<FJsonObject> DescriptorJson;
		int32 DescriptorPid = 0;
		if (FJsonSerializer::Deserialize(Reader, DescriptorJson) && DescriptorJson.IsValid())
		{
			DescriptorJson->TryGetNumberField(TEXT("pid"), DescriptorPid);
		}
		if (DescriptorPid == 0 || DescriptorPid == static_cast<int32>(StoppedProcessId))
		{
			IFileManager::Get().Delete(*DescriptorPath, false, true, true);
		}
	}

	UE_LOG(LogTemp, Display, TEXT("UEV control server stopped pid=%u"), StoppedProcessId);
}

TSharedRef<SDockTab> FUEVControlPanelModule::SpawnControlPanelTab(const FSpawnTabArgs& Args)
{
	return SNew(SDockTab)
		.TabRole(ETabRole::NomadTab)
		[
			SNew(SUEVControlPanel)
		];
}

void FUEVControlPanelModule::OpenControlPanel()
{
	FGlobalTabmanager::Get()->TryInvokeTab(UEVControlPanelTabName);
}

#undef LOCTEXT_NAMESPACE

IMPLEMENT_MODULE(FUEVControlPanelModule, UEVControlPanel)
