#include "SUEVControlPanel.h"

#include "Application/SlateApplicationBase.h"
#include "Dom/JsonObject.h"
#include "Framework/Application/SlateApplication.h"
#include "EditorStyleSet.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformApplicationMisc.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformTime.h"
#include "UEVControlPanelModule.h"
#include "Misc/FileHelper.h"
#include "Misc/MessageDialog.h"
#include "Modules/ModuleManager.h"
#include "Misc/Paths.h"
#include "Policies/PrettyJsonPrintPolicy.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Styling/CoreStyle.h"
#include "Widgets/Input/SCheckBox.h"
#include "Widgets/Input/SComboBox.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/Layout/SSplitter.h"
#include "Widgets/Layout/SSpacer.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/SWindow.h"
#include "Widgets/Views/STableRow.h"

namespace
{
	TSharedPtr<FJsonObject> ParseControlPanelJson(const FString& Text)
	{
		TSharedPtr<FJsonObject> Object;
		const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Text);
		if (!FJsonSerializer::Deserialize(Reader, Object))
		{
			return nullptr;
		}
		return Object;
	}

	FString SerializeParamValue(const TSharedPtr<FJsonValue>& Value)
	{
		if (!Value.IsValid())
		{
			return FString();
		}
		FString Text;
		const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Text);
		if (Value->Type == EJson::Object)
		{
			FJsonSerializer::Serialize(Value->AsObject().ToSharedRef(), Writer);
			return Text;
		}
		if (Value->Type == EJson::Array)
		{
			FJsonSerializer::Serialize(Value->AsArray(), Writer);
			return Text;
		}
		return FString();
	}
}

namespace
{
	/** Parse a JSON fragment of any shape (object, array or scalar) by wrapping it in an object. */
	TSharedPtr<FJsonValue> ParseControlPanelValue(const FString& Text)
	{
		const FString Trimmed = Text.TrimStartAndEnd();
		if (Trimmed.IsEmpty())
		{
			return nullptr;
		}
		const FString Wrapped = FString::Printf(TEXT("{\"value\":%s}"), *Trimmed);
		const TSharedPtr<FJsonObject> Wrapper = ParseControlPanelJson(Wrapped);
		return Wrapper.IsValid() ? Wrapper->TryGetField(TEXT("value")) : nullptr;
	}

	/** One-line text for a JSON value, used by the typed form editors. */
	FString SerializeValueText(const TSharedPtr<FJsonValue>& Value)
	{
		if (!Value.IsValid())
		{
			return FString();
		}
		switch (Value->Type)
		{
		case EJson::String:
			return Value->AsString();
		case EJson::Number:
			return FString::SanitizeFloat(Value->AsNumber());
		case EJson::Boolean:
			return Value->AsBool() ? TEXT("true") : TEXT("false");
		case EJson::Null:
			return FString();
		default:
			return SerializeParamValue(Value);
		}
	}

	FString DescribeParamType(const FUEVParamInfo& Param)
	{
		if (Param.Type == TEXT("array"))
		{
			return (Param.bHasItems && Param.Items.IsValid())
				? FString::Printf(TEXT("array<%s>"), *DescribeParamType(*Param.Items))
				: FString(TEXT("array"));
		}
		return Param.Type.IsEmpty() ? FString(TEXT("any")) : Param.Type;
	}

	/** Resolve a dotted property path ("a.b") inside one JSON object. */
	bool GetObjectPathValue(
		const TSharedPtr<FJsonObject>& Object,
		const FString& PropertyPath,
		TSharedPtr<FJsonValue>& OutValue)
	{
		OutValue.Reset();
		if (!Object.IsValid() || PropertyPath.IsEmpty())
		{
			return false;
		}
		TArray<FString> Segments;
		PropertyPath.ParseIntoArray(Segments, TEXT("."), true);
		if (Segments.Num() == 0)
		{
			return false;
		}
		TSharedPtr<FJsonObject> Cursor = Object;
		for (int32 Index = 0; Index < Segments.Num(); ++Index)
		{
			const TSharedPtr<FJsonValue> Field = Cursor->TryGetField(Segments[Index]);
			if (!Field.IsValid())
			{
				return false;
			}
			if (Index == Segments.Num() - 1)
			{
				OutValue = Field;
				return true;
			}
			const TSharedPtr<FJsonObject>* Nested = nullptr;
			if (Field->Type != EJson::Object || !Field->TryGetObject(Nested) || !Nested || !Nested->IsValid())
			{
				return false;
			}
			Cursor = *Nested;
		}
		return false;
	}

	/** Write (or delete, when Value is null) a dotted property path inside one JSON object, creating parents. */
	void SetObjectPathValue(
		const TSharedPtr<FJsonObject>& Object,
		const FString& PropertyPath,
		const TSharedPtr<FJsonValue>& Value)
	{
		if (!Object.IsValid())
		{
			return;
		}
		TArray<FString> Segments;
		PropertyPath.ParseIntoArray(Segments, TEXT("."), true);
		if (Segments.Num() == 0)
		{
			return;
		}
		TSharedPtr<FJsonObject> Cursor = Object;
		for (int32 Index = 0; Index < Segments.Num(); ++Index)
		{
			const bool bLast = Index == Segments.Num() - 1;
			if (bLast)
			{
				if (Value.IsValid())
				{
					Cursor->SetField(Segments[Index], Value);
				}
				else
				{
					Cursor->RemoveField(Segments[Index]);
				}
				continue;
			}
			const TSharedPtr<FJsonValue> Field = Cursor->TryGetField(Segments[Index]);
			const TSharedPtr<FJsonObject>* Nested = nullptr;
			TSharedPtr<FJsonObject> Next =
				(Field.IsValid() && Field->Type == EJson::Object && Field->TryGetObject(Nested) && Nested && Nested->IsValid())
					? *Nested
					: MakeShared<FJsonObject>();
			Cursor->SetObjectField(Segments[Index], Next);
			Cursor = Next;
		}
	}

	FString DescribeParamTarget(const FUEVParamTarget& Target)
	{
		if (Target.Scope == EUEVParamScope::Property)
		{
			return FString::Printf(TEXT("%s.%s"), *Target.ParamName, *Target.PropertyName);
		}
		if (Target.Scope == EUEVParamScope::Element)
		{
			return Target.PropertyName.IsEmpty()
				? FString::Printf(TEXT("%s[%d]"), *Target.ParamName, Target.ArrayIndex)
				: FString::Printf(TEXT("%s[%d].%s"), *Target.ParamName, Target.ArrayIndex, *Target.PropertyName);
		}
		return Target.ParamName;
	}

	/** Only string parameters that clearly name an Unreal asset get the asset picker. */
	bool IsAssetPathParam(const FUEVParamInfo& Param)
	{
		if (Param.Type != TEXT("string"))
		{
			return false;
		}
		const FString Name = Param.Name.ToLower();
		if (Name.EndsWith(TEXT("_path")) || Name.EndsWith(TEXT("_asset")))
		{
			const bool bFileLike =
				Name.Contains(TEXT("file")) ||
				Name.Contains(TEXT("script")) ||
				Name.Contains(TEXT("directory")) ||
				Name.Contains(TEXT("folder")) ||
				Name.Contains(TEXT("config")) ||
				Name.Contains(TEXT("log"));
			return !bFileLike;
		}
		const FString Description = Param.Description.ToLower();
		return Description.Contains(TEXT("asset path")) || Description.Contains(TEXT("asset class"));
	}

	FString JoinJsonValues(const TSharedPtr<FJsonValue>& Value)
	{
		if (!Value.IsValid())
		{
			return FString();
		}
		if (Value->Type == EJson::Array)
		{
			TArray<FString> Parts;
			for (const TSharedPtr<FJsonValue>& Item : Value->AsArray())
			{
				Parts.Add(SerializeValueText(Item));
			}
			return FString::Join(Parts, TEXT(", "));
		}
		return SerializeValueText(Value);
	}

	FString FormatJsonField(const TSharedPtr<FJsonObject>& Json, const FString& Field)
	{
		return Json.IsValid() ? JoinJsonValues(Json->TryGetField(Field)) : FString();
	}

	TSharedPtr<FString> FindOption(const TArray<TSharedPtr<FString>>& Options, const FString& Value)
	{
		for (const TSharedPtr<FString>& Option : Options)
		{
			if (Option.IsValid() && Option->Equals(Value, ESearchCase::IgnoreCase))
			{
				return Option;
			}
		}
		return nullptr;
	}

	const TCHAR* const UEVExpectedProductVersion = TEXT("1.7.0");
	constexpr int32 UEVExpectedProtocolVersion = 2;
}

void SUEVControlPanel::Construct(const FArguments& InArgs)
{
	Client = MakeShared<FUEVControlClient>();
	ParamsJson = TEXT("{}");
	ResultText = TEXT("Ready.");
	StatusMessage = TEXT("Refresh to connect.");

	ChildSlot
	[
		SNew(SBox)
		.MinDesiredWidth(960.0f)
		.MinDesiredHeight(540.0f)
		[
			SNew(SVerticalBox)
			+ SVerticalBox::Slot()
			.AutoHeight()
			.Padding(6.0f, 5.0f, 6.0f, 3.0f)
			[
				BuildToolbar()
			]
		+ SVerticalBox::Slot()
		.FillHeight(1.0f)
		.Padding(4.0f)
		[
			SNew(SSplitter)
			.Orientation(Orient_Horizontal)
			+ SSplitter::Slot()
			.Value(0.33f)
			[
				SNew(SBorder)
				.BorderImage(FEditorStyle::GetBrush("ToolPanel.GroupBorder"))
				.Padding(4.0f)
				[
					SNew(SVerticalBox)
					+ SVerticalBox::Slot()
					.AutoHeight()
					.Padding(0.0f, 0.0f, 0.0f, 4.0f)
					[
						SAssignNew(SearchBox, SSearchBox)
						.HintText(FText::FromString(TEXT("Filter actions...")))
						.OnTextChanged(this, &SUEVControlPanel::OnSearchChanged)
					]
					+ SVerticalBox::Slot()
					.FillHeight(1.0f)
					[
						SAssignNew(ToolListView, SListView<TSharedPtr<FUEVToolRow>>)
						.ListItemsSource(&ToolRows)
						.OnGenerateRow(this, &SUEVControlPanel::OnGenerateToolRow)
						.OnSelectionChanged(this, &SUEVControlPanel::OnToolSelectionChanged)
						.SelectionMode(ESelectionMode::Single)
					]
				]
			]
			+ SSplitter::Slot()
			.Value(0.72f)
			[
				SNew(SSplitter)
				.Orientation(Orient_Vertical)
				+ SSplitter::Slot()
				.Value(0.50f)
				[
					SNew(SBorder)
					.BorderImage(FEditorStyle::GetBrush("ToolPanel.GroupBorder"))
					.Padding(4.0f)
					[
						SNew(SVerticalBox)
						+ SVerticalBox::Slot()
						.AutoHeight()
						.Padding(0.0f, 0.0f, 0.0f, 4.0f)
						[
							SAssignNew(SelectionText, STextBlock)
							.Text(FText::FromString(TEXT("Select an action.")))
							.AutoWrapText(true)
						]
						+ SVerticalBox::Slot()
						.FillHeight(1.0f)
						[
							SNew(SSplitter)
							.Orientation(Orient_Vertical)
							+ SSplitter::Slot()
							.Value(0.58f)
							[
								SNew(SVerticalBox)
								+ SVerticalBox::Slot()
								.AutoHeight()
								.Padding(0.0f, 0.0f, 0.0f, 3.0f)
								[
									SNew(STextBlock)
									.Text(FText::FromString(TEXT("Generated form")))
									.Font(FCoreStyle::GetDefaultFontStyle("Bold", 8))
								]
								+ SVerticalBox::Slot()
								.FillHeight(1.0f)
								[
									SNew(SScrollBox)
									+ SScrollBox::Slot()
									[
										SAssignNew(ParamFormBox, SVerticalBox)
									]
								]
							]
							+ SSplitter::Slot()
							.Value(0.42f)
							[
								SNew(SVerticalBox)
								+ SVerticalBox::Slot()
								.AutoHeight()
								.Padding(0.0f, 0.0f, 0.0f, 3.0f)
								[
									SNew(STextBlock)
									.Text(FText::FromString(TEXT("JSON params")))
									.Font(FCoreStyle::GetDefaultFontStyle("Bold", 8))
								]
								+ SVerticalBox::Slot()
								.FillHeight(1.0f)
								[
									SAssignNew(ParamsEditor, SMultiLineEditableTextBox)
									.Font(FCoreStyle::GetDefaultFontStyle("Mono", 9))
									.Text(FText::FromString(TEXT("{}")))
									.OnTextChanged(this, &SUEVControlPanel::OnParamsChanged)
									.AlwaysShowScrollbars(true)
								]
							]
						]
						+ SVerticalBox::Slot()
						.AutoHeight()
						.Padding(0.0f, 4.0f, 0.0f, 0.0f)
						[
							SNew(SHorizontalBox)
							+ SHorizontalBox::Slot()
							.AutoWidth()
							.Padding(0.0f, 0.0f, 6.0f, 0.0f)
							[
								SAssignNew(RunButton, SButton)
								.Text(FText::FromString(TEXT("Run")))
								.ButtonColorAndOpacity(this, &SUEVControlPanel::GetRunButtonColor)
								.OnClicked(this, &SUEVControlPanel::OnRunClicked)
								.IsEnabled(this, &SUEVControlPanel::CanRun)
							]
							+ SHorizontalBox::Slot()
							.AutoWidth()
							.Padding(0.0f, 0.0f, 6.0f, 0.0f)
							[
								SNew(SButton)
								.Text(FText::FromString(TEXT("Template")))
								.OnClicked(this, &SUEVControlPanel::OnTemplateClicked)
							]
							+ SHorizontalBox::Slot()
							.AutoWidth()
							.Padding(0.0f, 0.0f, 6.0f, 0.0f)
							[
								SNew(SButton)
								.Text(FText::FromString(TEXT("Sync Form")))
								.OnClicked(this, &SUEVControlPanel::OnSyncFormClicked)
							]
							+ SHorizontalBox::Slot()
							.FillWidth(1.0f)
							.VAlign(VAlign_Center)
							[
								SAssignNew(StatusText, STextBlock)
								.Text(FText::FromString(TEXT("Ready")))
							]
						]
					]
				]
				+ SSplitter::Slot()
				.Value(0.30f)
				[
					SNew(SBorder)
					.BorderImage(FEditorStyle::GetBrush("ToolPanel.GroupBorder"))
					.Padding(4.0f)
					[
						SNew(SVerticalBox)
						+ SVerticalBox::Slot()
						.AutoHeight()
						.Padding(0.0f, 0.0f, 0.0f, 4.0f)
						[
							SNew(SHorizontalBox)
							+ SHorizontalBox::Slot()
							.FillWidth(1.0f)
							.VAlign(VAlign_Center)
							[
								SNew(STextBlock)
								.Text(FText::FromString(TEXT("Result")))
							]
							+ SHorizontalBox::Slot()
							.AutoWidth()
							.VAlign(VAlign_Center)
							.Padding(6.0f, 0.0f, 0.0f, 0.0f)
							[
								SAssignNew(ResultStatusText, STextBlock)
								.Text(GetCallStatusLabel())
								.Font(FCoreStyle::GetDefaultFontStyle("Bold", 8))
								.ColorAndOpacity(GetStatusColor())
							]
							+ SHorizontalBox::Slot()
							.AutoWidth()
							.Padding(0.0f, 0.0f, 4.0f, 0.0f)
							[
								SNew(SButton)
								.Text(FText::FromString(TEXT("Copy")))
								.OnClicked(this, &SUEVControlPanel::OnCopyResultClicked)
							]
							+ SHorizontalBox::Slot()
							.AutoWidth()
							[
								SNew(SButton)
								.Text(FText::FromString(TEXT("History")))
								.OnClicked(this, &SUEVControlPanel::OnHistoryClicked)
							]
						]
						+ SVerticalBox::Slot()
						.FillHeight(1.0f)
						[
							SNew(SBorder)
							.BorderImage(FCoreStyle::Get().GetBrush("WhiteBrush"))
							.BorderBackgroundColor(this, &SUEVControlPanel::GetResultBorderColor)
							.Padding(1.0f)
							[
								SAssignNew(ResultEditor, SMultiLineEditableTextBox)
								.Font(FCoreStyle::GetDefaultFontStyle("Mono", 9))
								.Text(FText::FromString(TEXT("Ready.")))
								.IsReadOnly(true)
								.ReadOnlyForegroundColor(this, &SUEVControlPanel::GetResultTextColor)
								.AlwaysShowScrollbars(true)
							]
						]
					]
				]
				+ SSplitter::Slot()
				.Value(0.20f)
				[
					SNew(SBorder)
					.BorderImage(FEditorStyle::GetBrush("ToolPanel.GroupBorder"))
					.Padding(4.0f)
					[
						SNew(SVerticalBox)
						+ SVerticalBox::Slot()
						.AutoHeight()
						.Padding(0.0f, 0.0f, 0.0f, 4.0f)
						[
							BuildHistoryBar()
						]
						+ SVerticalBox::Slot()
						.FillHeight(1.0f)
						[
							SAssignNew(HistoryListView, SListView<TSharedPtr<FUEVHistoryRow>>)
							.ListItemsSource(&HistoryRows)
							.OnGenerateRow(this, &SUEVControlPanel::OnGenerateHistoryRow)
							.OnSelectionChanged(this, &SUEVControlPanel::OnHistorySelectionChanged)
							.SelectionMode(ESelectionMode::Single)
						]
					]
				]
			]
		]
		]
	];

	UpdateConnectionText();
	UpdateStatusText();
	RefreshAll();
}

void SUEVControlPanel::Tick(const FGeometry& AllottedGeometry, const double InCurrentTime, const float InDeltaTime)
{
	SCompoundWidget::Tick(AllottedGeometry, InCurrentTime, InDeltaTime);

	if (const TSharedPtr<SWindow> ParentWindow = FSlateApplicationBase::Get().FindWidgetWindow(SharedThis(this)))
	{
		const FString ParentTitle = ParentWindow->GetTitle().ToString();
		if (ParentTitle.Contains(TEXT("UEV Control Panel"), ESearchCase::IgnoreCase) ||
			ParentTitle.Contains(TEXT("UEV Control Panel"), ESearchCase::IgnoreCase))
		{
			const FVector2D CurrentSize = ParentWindow->GetSizeInScreen();
			const FVector2D MinimumSize(960.0f, 540.0f);
			if (CurrentSize.X < MinimumSize.X || CurrentSize.Y < MinimumSize.Y)
			{
				const FVector2D NewSize(
					FMath::Max(CurrentSize.X, MinimumSize.X),
					FMath::Max(CurrentSize.Y, MinimumSize.Y));
				FVector2D NewPosition = ParentWindow->GetPositionInScreen();
				const FSlateRect WorkArea = FSlateApplicationBase::Get().GetPreferredWorkArea();
				NewPosition.X = FMath::Max(WorkArea.Left, FMath::Min(NewPosition.X, WorkArea.Right - NewSize.X));
				NewPosition.Y = FMath::Max(WorkArea.Top, FMath::Min(NewPosition.Y, WorkArea.Bottom - NewSize.Y));
				ParentWindow->ReshapeWindow(NewPosition, NewSize);
			}
		}
	}

	if (bFormRefreshPending)
	{
		bFormRefreshPending = false;
		RebuildParamForm();
	}

	const double Now = FPlatformTime::Seconds();
	FUEVControlPanelModule* Module = FModuleManager::GetModulePtr<FUEVControlPanelModule>(TEXT("UEVControlPanel"));
	const bool bControlServerOwned = Module != nullptr && Module->IsControlServerOwned();
	if (bControlServerOwned != bControlServerOwnedLast)
	{
		bControlServerOwnedLast = bControlServerOwned;
		if (bControlServerOwned && !bConnected)
		{
			bControlStartRequested = true;
			ControlStartRequestTime = Now;
			LastHealthPoll = 0.0;
			SetCallStatus(EUEVCallStatus::Warning, TEXT("Starting UEV control..."));
			UpdateConnectionText();
		}
		else if (!bControlServerOwned && bControlStartRequested)
		{
			bControlStartRequested = false;
		}
	}

	const double HealthInterval = bControlStartRequested ? 0.75 : 5.0;
	if (Now - LastHealthPoll >= HealthInterval)
	{
		LastHealthPoll = Now;
		if (!bConnected && Client.IsValid() && Client->LoadDescriptor())
		{
			RefreshCatalog();
		}
		RefreshHealth();
	}

	if (bControlStartRequested && Now - ControlStartRequestTime > 20.0)
	{
		bControlStartRequested = false;
		SetCallStatus(
			EUEVCallStatus::Warning,
			TEXT("UEV control did not come online. Check that PythonScriptPlugin is enabled and the installer completed."));
		UpdateConnectionText();
	}

	if (Now - LastPiePoll >= 30.0)
	{
		LastPiePoll = Now;
		RefreshPieStatus();
	}
}

void SUEVControlPanel::RefreshAll()
{
	// Crash guard (panel-reentrancy): a refresh triggered from inside a refresh
	// re-enters RebuildToolRows/RebuildParamForm and can exhaust the Slate stack.
	if (bRefreshInFlight)
	{
		UE_LOG(LogTemp, Warning, TEXT("UEV control panel: nested refresh skipped (panel-reentrancy crash guard)."));
		return;
	}
	struct FRefreshInFlightGuard
	{
		bool& Flag;
		explicit FRefreshInFlightGuard(bool& InFlag) : Flag(InFlag) { Flag = true; }
		~FRefreshInFlightGuard() { Flag = false; }
	} RefreshGuard(bRefreshInFlight);

	if (!Client.IsValid())
	{
		return;
	}

	if (!Client->LoadDescriptor())
	{
		bConnected = false;
		SetCallStatus(EUEVCallStatus::Failure, Client->GetLastError());
		UpdateConnectionText();
		return;
	}

	SetCallStatus(EUEVCallStatus::Idle, TEXT("Refreshing..."));
	RefreshHealth();
	RefreshCatalog();
	RefreshHistory();
}

void SUEVControlPanel::RefreshHealth()
{
	if (!Client.IsValid() || bHealthInFlight)
	{
		return;
	}

	if (!Client->IsConnected() && !Client->LoadDescriptor())
	{
		bConnected = false;
		UpdateConnectionText();
		return;
	}

	bHealthInFlight = true;
	const TWeakPtr<SUEVControlPanel> WeakPanel = StaticCastSharedRef<SUEVControlPanel>(SharedThis(this));
	Client->GetHealth([WeakPanel](const FUEVControlHealth& InHealth, const bool bOk)
	{
		if (const TSharedPtr<SUEVControlPanel> This = WeakPanel.Pin())
		{
			This->bHealthInFlight = false;
			This->Health = InHealth;
			This->UpdateCompatibilityState();
			This->bConnected = bOk;
			if (bOk && This->bControlStartRequested)
			{
				This->bControlStartRequested = false;
				This->SetCallStatus(EUEVCallStatus::Success, TEXT("UEV control online."));
				This->RefreshCatalog();
			}
			else if (!bOk && !InHealth.Error.IsEmpty() && !This->bRequestInFlight)
			{
				This->SetCallStatus(EUEVCallStatus::Failure, InHealth.Error);
			}
			This->UpdateConnectionText();
		}
	});
}

void SUEVControlPanel::RefreshCatalog()
{
	if (!Client.IsValid() || !Client->IsConnected())
	{
		return;
	}

	const TWeakPtr<SUEVControlPanel> WeakPanel = StaticCastSharedRef<SUEVControlPanel>(SharedThis(this));
	Client->GetCatalog([WeakPanel](const TArray<FUEVControlTool>& InTools, const FUEVControlCatalogInfo& InInfo, const bool bOk)
	{
		if (const TSharedPtr<SUEVControlPanel> This = WeakPanel.Pin())
		{
			if (bOk)
			{
				This->Tools = InTools;
				This->CatalogInfo = InInfo;
				This->UnsupportedReasons.Reset();
				This->UpdateCompatibilityState();
				This->RebuildToolRows();
				if (This->CallStatus == EUEVCallStatus::Idle)
				{
					This->SetCallStatus(
						EUEVCallStatus::Success,
						FString::Printf(TEXT("Loaded %d tools."), InTools.Num()));
				}
			}
			else
			{
				This->CatalogInfo = InInfo;
			This->UpdateCompatibilityState();
			This->SetCallStatus(EUEVCallStatus::Warning, TEXT("Failed to load the tool catalog."));
			}
			This->UpdateConnectionText();
		}
	});
}

void SUEVControlPanel::RefreshPieStatus()
{
	if (!Client.IsValid() || !Client->IsConnected() || bPieInFlight)
	{
		return;
	}

	bPieInFlight = true;
	const TWeakPtr<SUEVControlPanel> WeakPanel = StaticCastSharedRef<SUEVControlPanel>(SharedThis(this));
	Client->CallTool(TEXT("manage_editor"), TEXT("is_pie_running"), MakeShared<FJsonObject>(),
		[WeakPanel](const FUEVControlCallResult& Result)
		{
			if (const TSharedPtr<SUEVControlPanel> This = WeakPanel.Pin())
			{
				This->bPieInFlight = false;
				if (Result.bOk)
				{
					const TSharedPtr<FJsonObject> Json = ParseControlPanelJson(Result.Text);
					bool bRunning = false;
					if (Json.IsValid() && Json->TryGetBoolField(TEXT("is_pie_running"), bRunning))
					{
						This->bPieRunning = bRunning;
						This->bPieKnown = true;
					}
				}
				This->UpdateConnectionText();
			}
		});
}

void SUEVControlPanel::RefreshHistory()
{
	if (!Client.IsValid() || !Client->IsConnected())
	{
		return;
	}

	const TWeakPtr<SUEVControlPanel> WeakPanel = StaticCastSharedRef<SUEVControlPanel>(SharedThis(this));
	Client->GetHistory(200, [WeakPanel](const TArray<FUEVControlHistoryEntry>& Entries, const bool bOk)
	{
		if (const TSharedPtr<SUEVControlPanel> This = WeakPanel.Pin())
		{
			if (!bOk)
			{
				This->SetCallStatus(EUEVCallStatus::Warning, TEXT("Failed to load history."));
				return;
			}

			This->AllHistoryRows.Reset();
			for (const FUEVControlHistoryEntry& Entry : Entries)
			{
				if (Entry.Tool == TEXT("manage_editor") && Entry.Action == TEXT("is_pie_running"))
				{
					continue;
				}
				const TSharedPtr<FUEVHistoryRow> Row = MakeShared<FUEVHistoryRow>();
				Row->Entry = Entry;
				const bool bResultFailure =
					Entry.ResultSummary.Contains(TEXT("\"success\": false")) ||
					Entry.ResultSummary.Contains(TEXT("\"success\":false")) ||
					Entry.ResultSummary.Contains(TEXT("Traceback (most recent call last)"));
				if (bResultFailure)
				{
					Row->Entry.Status = TEXT("failed");
				}
				const FString ActionLabel = Entry.Action.IsEmpty()
					? Entry.Tool
					: FString::Printf(TEXT("%s.%s"), *Entry.Tool, *Entry.Action);
				Row->Label = FString::Printf(
					TEXT("%s  %s  %s"),
					*Entry.Timestamp,
					*ActionLabel,
					*SingleLine(Entry.ResultSummary, 80));
				This->AllHistoryRows.Add(Row);
			}

			if (This->AllHistoryRows.Num() > 0 && This->SelectedHistoryId.IsEmpty())
			{
				This->SelectedHistoryId = This->AllHistoryRows[0]->Entry.Id;
			}

			This->RefreshHistoryFilterOptions();
			This->ApplyHistoryFilters();
		}
	});
}

void SUEVControlPanel::RebuildToolRows()
{
	// Crash guard (panel-reentrancy): cap nested rebuilds so a Slate layout loop
	// cannot exhaust the stack.
	if (RebuildDepth >= MaxRebuildDepth)
	{
		UE_LOG(LogTemp, Warning, TEXT("UEV control panel: nested tool row rebuild skipped at depth %d (panel-reentrancy crash guard)."), RebuildDepth);
		return;
	}
	struct FRebuildDepthGuard
	{
		int32& Depth;
		explicit FRebuildDepthGuard(int32& InDepth) : Depth(InDepth) { ++Depth; }
		~FRebuildDepthGuard() { --Depth; }
	} ToolRowsGuard(RebuildDepth);

	ToolRows.Reset();
	const FString Filter = SearchText.TrimStartAndEnd();

	for (int32 ToolIndex = 0; ToolIndex < Tools.Num(); ++ToolIndex)
	{
		const FUEVControlTool& Tool = Tools[ToolIndex];
		if (Tool.Actions.Num() == 0)
		{
			if (!Tool.bHasDirect)
			{
				continue;
			}

			const TSharedPtr<FUEVToolRow> Row = MakeShared<FUEVToolRow>();
			Row->ToolIndex = ToolIndex;
			Row->ActionIndex = INDEX_NONE;
			Row->bDirect = true;
			Row->Label = Tool.Name;
			Row->Mode = Tool.Direct.Mode;
			Row->bAllowed = Tool.Direct.bAllowed;
			Row->Tooltip = Tool.Description;
			if (Filter.IsEmpty() || Row->Label.Contains(Filter, ESearchCase::IgnoreCase))
			{
				ToolRows.Add(Row);
			}
			continue;
		}

		for (int32 ActionIndex = 0; ActionIndex < Tool.Actions.Num(); ++ActionIndex)
		{
			const FUEVControlAction& Action = Tool.Actions[ActionIndex];
			const TSharedPtr<FUEVToolRow> Row = MakeShared<FUEVToolRow>();
			Row->ToolIndex = ToolIndex;
			Row->ActionIndex = ActionIndex;
			Row->bDirect = false;
			Row->Label = FString::Printf(TEXT("%s.%s"), *Tool.Name, *Action.Name);
			Row->Mode = Action.Mode;
			Row->bAllowed = Action.bAllowed;
			Row->Tooltip = Action.Note.IsEmpty() ? Tool.Description : Action.Note;
			if (Filter.IsEmpty() || Row->Label.Contains(Filter, ESearchCase::IgnoreCase))
			{
				ToolRows.Add(Row);
			}
		}
	}

	ToolRows.Sort([](const TSharedPtr<FUEVToolRow>& Left, const TSharedPtr<FUEVToolRow>& Right)
	{
		return Left->Label < Right->Label;
	});

	if (ToolListView.IsValid())
	{
		ToolListView->RequestListRefresh();
	}

	TSharedPtr<FUEVToolRow> ToSelect;
	for (const TSharedPtr<FUEVToolRow>& Row : ToolRows)
	{
		if (Row->ToolIndex == SelectedToolIndex && Row->ActionIndex == SelectedActionIndex && Row->bDirect == bSelectedDirect)
		{
			ToSelect = Row;
			break;
		}
	}
	if (!ToSelect.IsValid() && ToolRows.Num() > 0)
	{
		ToSelect = ToolRows[0];
	}
	if (ToSelect.IsValid() && ToolListView.IsValid())
	{
		ToolListView->SetSelection(ToSelect);
	}
}

void SUEVControlPanel::RebuildHistoryRows()
{
	if (HistoryListView.IsValid())
	{
		HistoryListView->RequestListRefresh();
	}
}

void SUEVControlPanel::UpdateConnectionText()
{
	if (ConnectionText.IsValid())
	{
		FString Text;
		FSlateColor Color;
		if (bConnected)
		{
			Text = FString::Printf(TEXT("Control: online :%d"), Client->GetDescriptor().Port);
			Color = FSlateColor(FLinearColor(0.4f, 0.9f, 0.4f));
		}
		else if (bControlStartRequested)
		{
			Text = TEXT("Control: starting...");
			Color = FSlateColor(FLinearColor(1.0f, 0.72f, 0.2f));
		}
		else
		{
			Text = TEXT("Control: offline");
			Color = FSlateColor(FLinearColor(0.9f, 0.4f, 0.4f));
			if (Client.IsValid() && !Client->GetDescriptorPath().IsEmpty())
			{
				Text += FString::Printf(TEXT(" (%s)"), *Client->GetDescriptorPath());
			}
		}
		ConnectionText->SetText(FText::FromString(Text));
		ConnectionText->SetColorAndOpacity(Color);
	}

	if (ProfileText.IsValid())
	{
		const FString Profile = Health.Profile.IsEmpty() && Client.IsValid() ? Client->GetDescriptor().Profile : Health.Profile;
		const bool bReadOnly = Health.bReadOnly || (Client.IsValid() && Client->GetDescriptor().bReadOnly);
		ProfileText->SetText(FText::FromString(
			FString::Printf(TEXT("Profile: %s%s"), *Profile, bReadOnly ? TEXT(" (read-only)") : TEXT(""))));
		ProfileText->SetColorAndOpacity(
			Profile == TEXT("supervised") ? FSlateColor(FLinearColor(1.0f, 0.75f, 0.25f)) : FSlateColor(FLinearColor(0.6f, 0.8f, 1.0f)));
	}

	if (SupervisorText.IsValid())
	{
		FUEVControlPanelModule* Module = FModuleManager::GetModulePtr<FUEVControlPanelModule>(TEXT("UEVControlPanel"));
		const bool bPanelOwned = Module != nullptr && Module->IsControlServerOwned();
		FString Supervisor = Health.SupervisorStatus.IsEmpty() ? TEXT("unknown") : Health.SupervisorStatus;
		if (bPanelOwned && Supervisor != TEXT("connected"))
		{
			Supervisor = TEXT("standalone");
		}
		SupervisorText->SetText(FText::FromString(FString::Printf(TEXT("Supervisor: %s"), *Supervisor)));
		SupervisorText->SetColorAndOpacity(
			Supervisor == TEXT("connected")
				? FSlateColor(FLinearColor(0.25f, 0.85f, 0.35f))
				: (Supervisor == TEXT("offline")
					? FSlateColor(FLinearColor(0.95f, 0.25f, 0.25f))
					: FSlateColor(FLinearColor(0.6f, 0.6f, 0.6f))));
	}
	if (PieText.IsValid())
	{
		const TCHAR* PieState = !bPieKnown ? TEXT("PIE: unknown") : (bPieRunning ? TEXT("PIE: running") : TEXT("PIE: stopped"));
		PieText->SetText(FText::FromString(FString(PieState)));
		PieText->SetColorAndOpacity(GetPieColor());
	}
}

void SUEVControlPanel::UpdateStatusText()
{
	if (StatusText.IsValid())
	{
		StatusText->SetText(FText::FromString(StatusMessage));
		StatusText->SetColorAndOpacity(GetStatusColor());
	}
	if (ResultStatusText.IsValid())
	{
		ResultStatusText->SetText(GetCallStatusLabel());
		ResultStatusText->SetColorAndOpacity(GetStatusColor());
	}
}

TSharedRef<SWidget> SUEVControlPanel::BuildToolbar()
{
	return SNew(SVerticalBox)
		+ SVerticalBox::Slot()
		.AutoHeight()
		[
			SNew(SHorizontalBox)
			+ SHorizontalBox::Slot()
		.AutoWidth()
		.VAlign(VAlign_Center)
		.Padding(0.0f, 0.0f, 8.0f, 0.0f)
		[
			SAssignNew(ProfileText, STextBlock)
			.Text(FText::FromString(TEXT("Profile: -")))
		]
		+ SHorizontalBox::Slot()
		.AutoWidth()
		.VAlign(VAlign_Center)
		.Padding(0.0f, 0.0f, 8.0f, 0.0f)
		[
			SAssignNew(SupervisorText, STextBlock)
			.Text(FText::FromString(TEXT("Supervisor: -")))
		]
		+ SHorizontalBox::Slot()
		.AutoWidth()
		.VAlign(VAlign_Center)
		.Padding(0.0f, 0.0f, 8.0f, 0.0f)
		[
			SAssignNew(ConnectionText, STextBlock)
			.Text(FText::FromString(TEXT("Control: offline")))
		]
		+ SHorizontalBox::Slot()
		.AutoWidth()
		.VAlign(VAlign_Center)
		.Padding(0.0f, 0.0f, 8.0f, 0.0f)
		[
			SAssignNew(PieText, STextBlock)
			.Text(FText::FromString(TEXT("PIE: unknown")))
		]
		+ SHorizontalBox::Slot()
		.FillWidth(1.0f)
		.VAlign(VAlign_Center)
		[
			SNew(SSpacer)
		]
		+ SHorizontalBox::Slot()
		.AutoWidth()
		.Padding(0.0f, 0.0f, 4.0f, 0.0f)
		[
			SNew(SButton)
			.Text(FText::FromString(TEXT("Refresh")))
			.OnClicked(this, &SUEVControlPanel::OnRefreshClicked)
		]
		+ SHorizontalBox::Slot()
		.AutoWidth()
		.Padding(0.0f, 0.0f, 4.0f, 0.0f)
		[
			SNew(SButton)
			.Text(this, &SUEVControlPanel::GetControlButtonLabel)
			.ToolTipText(FText::FromString(TEXT("Start or stop the local UEV control API for this editor session.")))
			.OnClicked(this, &SUEVControlPanel::OnControlToggleClicked)
			.IsEnabled(this, &SUEVControlPanel::CanToggleControl)
		]
		+ SHorizontalBox::Slot()
		.AutoWidth()
		.Padding(0.0f, 0.0f, 4.0f, 0.0f)
		[
			SNew(SButton)
			.Text(FText::FromString(TEXT("Supervisor")))
			.ToolTipText(FText::FromString(TEXT("Start the supervisor after this editor closes. The supervisor must own the editor at launch.")))
			.OnClicked(this, &SUEVControlPanel::OnSupervisorClicked)
			.IsEnabled(this, &SUEVControlPanel::CanStartSupervisor)
		]
		+ SHorizontalBox::Slot()
		.AutoWidth()
		.Padding(0.0f, 0.0f, 4.0f, 0.0f)
		[
			SNew(SButton)
			.Text(FText::FromString(TEXT("Verify")))
			.ToolTipText(FText::FromString(TEXT("Run the installed verification: server, Node, Python scripts, plugin DLLs, project entries, and remote execution.")))
			.OnClicked(this, &SUEVControlPanel::OnVerifyClicked)
			.IsEnabled(this, &SUEVControlPanel::CanVerify)
		]
		+ SHorizontalBox::Slot()
		.AutoWidth()
		.Padding(0.0f, 0.0f, 4.0f, 0.0f)
		[
			SNew(SButton)
			.Text(FText::FromString(TEXT("Artifacts")))
			.OnClicked(this, &SUEVControlPanel::OnArtifactsClicked)
		]
		+ SHorizontalBox::Slot()
		.AutoWidth()
		.Padding(0.0f, 0.0f, 4.0f, 0.0f)
		[
			SNew(SButton)
			.Text(FText::FromString(TEXT("Capture")))
			.OnClicked(this, &SUEVControlPanel::OnCaptureUiClicked)
		]
		+ SHorizontalBox::Slot()
		.AutoWidth()
		[
			SNew(SButton)
			.Text(FText::FromString(TEXT("Panic")))
			.ButtonColorAndOpacity(FSlateColor(FLinearColor(0.65f, 0.18f, 0.18f)))
			.OnClicked(this, &SUEVControlPanel::OnPanicClicked)
			]
		]
		+ SVerticalBox::Slot()
		.AutoHeight()
		.Padding(0.0f, 4.0f, 0.0f, 0.0f)
		[
			BuildRunRow()
		]
		+ SVerticalBox::Slot()
		.AutoHeight()
		.Padding(0.0f, 2.0f, 0.0f, 0.0f)
		[
			BuildCompatibilityBanner()
		]
		+ SVerticalBox::Slot()
		.AutoHeight()
		.Padding(0.0f, 2.0f, 0.0f, 0.0f)
		[
			BuildFooter()
		];
}

TSharedRef<SWidget> SUEVControlPanel::BuildHistoryBar()
{
	return SNew(SHorizontalBox)
		+ SHorizontalBox::Slot()
		.AutoWidth()
		.VAlign(VAlign_Center)
		.Padding(0.0f, 0.0f, 8.0f, 0.0f)
		[
			SNew(STextBlock)
			.Text(FText::FromString(TEXT("History")))
		]
		+ SHorizontalBox::Slot()
		.AutoWidth()
		.Padding(0.0f, 0.0f, 4.0f, 0.0f)
		[
			SNew(SButton)
			.Text(FText::FromString(TEXT("Refresh")))
			.OnClicked(this, &SUEVControlPanel::OnHistoryClicked)
		]
		+ SHorizontalBox::Slot()
		.AutoWidth()
		.Padding(0.0f, 0.0f, 4.0f, 0.0f)
		[
			SNew(SButton)
			.Text(FText::FromString(TEXT("Undo")))
			.OnClicked(this, &SUEVControlPanel::OnUndoClicked)
			.IsEnabled(this, &SUEVControlPanel::CanUndo)
		]
		+ SHorizontalBox::Slot()
		.AutoWidth()
		[
			SNew(SButton)
			.Text(FText::FromString(TEXT("Redo")))
			.OnClicked(this, &SUEVControlPanel::OnRedoClicked)
			.IsEnabled(this, &SUEVControlPanel::CanRedo)
		]
		+ SHorizontalBox::Slot()
		.AutoWidth()
		.VAlign(VAlign_Center)
		.Padding(10.0f, 0.0f, 4.0f, 0.0f)
		[
			BuildHistoryFilterCombo(
				HistoryToolOptions,
				HistoryToolSelection,
				HistoryToolCombo,
				TEXT("Tool"),
				TEXT("Filter history by tool."),
				[this](const FString& Value)
				{
					HistoryFilterTool = Value;
					RefreshHistoryFilterOptions();
					ApplyHistoryFilters();
				})
		]
		+ SHorizontalBox::Slot()
		.AutoWidth()
		.VAlign(VAlign_Center)
		.Padding(4.0f, 0.0f, 4.0f, 0.0f)
		[
			BuildHistoryFilterCombo(
				HistoryActionOptions,
				HistoryActionSelection,
				HistoryActionCombo,
				TEXT("Action"),
				TEXT("Filter history by action."),
				[this](const FString& Value)
				{
					HistoryFilterAction = Value;
					RefreshHistoryFilterOptions();
					ApplyHistoryFilters();
				})
		]
		+ SHorizontalBox::Slot()
		.AutoWidth()
		.VAlign(VAlign_Center)
		.Padding(4.0f, 0.0f, 4.0f, 0.0f)
		[
			BuildHistoryFilterCombo(
				HistoryStatusOptions,
				HistoryStatusSelection,
				HistoryStatusCombo,
				TEXT("Status"),
				TEXT("Filter by result status."),
				[this](const FString& Value)
				{
					HistoryFilterStatus = Value;
					ApplyHistoryFilters();
				})
		]
		+ SHorizontalBox::Slot()
		.AutoWidth()
		.VAlign(VAlign_Center)
		.Padding(10.0f, 0.0f, 0.0f, 0.0f)
		[
			SNew(SButton)
			.Text(FText::FromString(TEXT("Export JSON")))
			.ToolTipText(FText::FromString(TEXT("Write the filtered history to Saved/UEV/History.")))
			.OnClicked(this, &SUEVControlPanel::OnExportHistoryClicked)
		];
}

TSharedRef<ITableRow> SUEVControlPanel::OnGenerateToolRow(
	const TSharedPtr<FUEVToolRow> Item,
	const TSharedRef<STableViewBase>& OwnerTable)
{
	const FSlateColor LabelColor = Item->bAllowed
		? FSlateColor(FLinearColor(0.85f, 0.85f, 0.85f))
		: FSlateColor(FLinearColor(0.5f, 0.5f, 0.5f));

	return SNew(STableRow<TSharedPtr<FUEVToolRow>>, OwnerTable)
		.Padding(FMargin(4.0f, 2.0f))
		[
			SNew(SHorizontalBox)
			+ SHorizontalBox::Slot()
			.FillWidth(1.0f)
			.VAlign(VAlign_Center)
			[
				SNew(STextBlock)
				.Text(FText::FromString(Item->Label))
				.ToolTipText(FText::FromString(Item->Tooltip))
				.ColorAndOpacity(LabelColor)
			]
			+ SHorizontalBox::Slot()
			.AutoWidth()
			.VAlign(VAlign_Center)
			.Padding(4.0f, 0.0f, 0.0f, 0.0f)
			[
				SNew(STextBlock)
				.Text(FText::FromString(Item->Mode.ToUpper()))
				.ColorAndOpacity(GetModeColor(Item->Mode))
				.Font(FCoreStyle::GetDefaultFontStyle("Bold", 8))
			]
		];
}

void SUEVControlPanel::OnToolSelectionChanged(const TSharedPtr<FUEVToolRow> Item, ESelectInfo::Type SelectInfo)
{
	if (!Item.IsValid())
	{
		return;
	}

	SelectedToolIndex = Item->ToolIndex;
	SelectedActionIndex = Item->ActionIndex;
	bSelectedDirect = Item->bDirect;

	const FUEVControlAction* Action = GetSelectedAction();
	if (!Action)
	{
		return;
	}

	ParamsJson = LastParams.Contains(GetSelectionKey()) ? LastParams[GetSelectionKey()] : TEXT("{}");
	if (ParamsEditor.IsValid())
	{
		ParamsEditor->SetText(FText::FromString(ParamsJson));
	}
	RebuildParamForm();
	if (!Action->bSupportsDryRun && bDryRunRequested)
	{
		bDryRunRequested = false;
		SetCallStatus(
			EUEVCallStatus::Idle,
			FString::Printf(TEXT("Dry run disarmed: %s does not declare dry-run support."), *GetSelectionKey()));
	}

	if (SelectionText.IsValid())
	{
		const FString ToolName = Tools.IsValidIndex(SelectedToolIndex) ? Tools[SelectedToolIndex].Name : FString();
		FString Detail = FString::Printf(
			TEXT("%s\nMode: %s    Allowed: %s"),
			*ToolName,
			*Action->Mode,
			Action->bAllowed ? TEXT("yes") : TEXT("no"));
		if (!Action->Reason.IsEmpty())
		{
			Detail += FString::Printf(TEXT("\nReason: %s"), *Action->Reason);
		}
		if (!Action->Note.IsEmpty())
		{
			Detail += FString::Printf(TEXT("\nNote: %s"), *Action->Note);
		}
		if (!Action->Undo.IsEmpty())
		{
			Detail += FString::Printf(TEXT("\nUndo: %s"), *Action->Undo);
		}
		if (Action->bSupportsDryRun)
		{
			Detail += TEXT("\nDry run: supported");
		}
		else if (const FString* UnsupportedReason = UnsupportedReasons.Find(GetSelectionKey()))
		{
			Detail += FString::Printf(TEXT("\nDry run: unsupported (%s)"), **UnsupportedReason);
		}
		Detail += FString::Printf(TEXT("\n%s"), *FormatParamsHint());
		SelectionText->SetText(FText::FromString(Detail));
		SelectionText->SetColorAndOpacity(GetSelectionColor());
	}

	// The status line describes the action that is selected now, so a message left by the previous
	// action (an asset-pick confirmation, a dry-run refusal) must not survive the selection change.
	StatusMessage = FString::Printf(TEXT("Selected %s."), *GetSelectionKey());
	UpdateStatusText();
}

TSharedRef<ITableRow> SUEVControlPanel::OnGenerateHistoryRow(
	const TSharedPtr<FUEVHistoryRow> Item,
	const TSharedRef<STableViewBase>& OwnerTable)
{
	const FString Status = Item->Entry.Status;
	return SNew(STableRow<TSharedPtr<FUEVHistoryRow>>, OwnerTable)
		.Padding(FMargin(4.0f, 2.0f))
		[
			SNew(SHorizontalBox)
			+ SHorizontalBox::Slot()
			.FillWidth(1.0f)
			.VAlign(VAlign_Center)
			[
				SNew(STextBlock)
				.Text(FText::FromString(Item->Label))
				.ToolTipText(FText::FromString(Item->Entry.ResultSummary))
			]
			+ SHorizontalBox::Slot()
			.AutoWidth()
			.VAlign(VAlign_Center)
			.Padding(6.0f, 0.0f, 0.0f, 0.0f)
			[
				SNew(STextBlock)
				.Text(FText::FromString(Status.ToUpper()))
				.ColorAndOpacity(GetHistoryStatusColor(Status))
				.Font(FCoreStyle::GetDefaultFontStyle("Bold", 8))
			]
		];
}

void SUEVControlPanel::OnHistorySelectionChanged(const TSharedPtr<FUEVHistoryRow> Item, ESelectInfo::Type SelectInfo)
{
	SelectedHistoryId = Item.IsValid() ? Item->Entry.Id : FString();
}

void SUEVControlPanel::OnSearchChanged(const FText& NewText)
{
	SearchText = NewText.ToString();
	RebuildToolRows();
}

void SUEVControlPanel::OnParamsChanged(const FText& NewText)
{
	ParamsJson = NewText.ToString();
}

FReply SUEVControlPanel::OnRunClicked()
{
	if (bRequestInFlight || !Client.IsValid())
	{
		return FReply::Handled();
	}

	const FUEVControlAction* Action = GetSelectedAction();
	if (!Action)
	{
		SetCallStatus(EUEVCallStatus::Warning, TEXT("Select an action."));
		return FReply::Handled();
	}

	if (ParamsJson.TrimStartAndEnd().IsEmpty())
	{
		ParamsJson = TEXT("{}");
		if (ParamsEditor.IsValid())
		{
			ParamsEditor->SetText(FText::FromString(ParamsJson));
		}
	}

	TSharedPtr<FJsonObject> Params;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(ParamsJson);
	if (!FJsonSerializer::Deserialize(Reader, Params) || !Params.IsValid())
	{
		SetCallStatus(EUEVCallStatus::Warning, TEXT("Params must be a valid JSON object."));
		return FReply::Handled();
	}

	const FString CallKey = GetSelectionKey();
	if (bDryRunRequested)
	{
		if (!Action->bSupportsDryRun)
		{
			SetCallStatus(
				EUEVCallStatus::Warning,
				FString::Printf(
					TEXT("dry_run_unsupported: %s does not declare dry-run support; nothing was sent."),
					*CallKey));
			return FReply::Handled();
		}
		Params->SetBoolField(TEXT("dry_run"), true);
		CommitParams(Params);
	}

	if (!Action->bAllowed)
	{
		SetCallStatus(
			EUEVCallStatus::Warning,
			Action->Reason.IsEmpty() ? TEXT("Action is not allowed in the current profile.") : Action->Reason);
		return FReply::Handled();
	}

	if (Action->Mode != TEXT("read") || bDryRunRequested)
	{
		const FText Title = FText::FromString(bDryRunRequested ? TEXT("Confirm Dry Run") : TEXT("Confirm UEV Action"));
		const FText Message = FText::FromString(bDryRunRequested
			? FString::Printf(
				TEXT("Dry run %s?\n\nNothing will be applied by this panel; the action should report what it would do.\n\nParams:\n%s"),
				*CallKey,
				*ParamsJson)
			: FString::Printf(
				TEXT("Run %s?\n\nMode: %s\nParams:\n%s"),
				*CallKey,
				*Action->Mode,
				*ParamsJson));
		if (FMessageDialog::Open(EAppMsgType::YesNo, Message, &Title) != EAppReturnType::Yes)
		{
			return FReply::Handled();
		}
	}

	LastParams.Add(CallKey, ParamsJson);
	const FString ToolName = Tools[SelectedToolIndex].Name;
	const FString ActionName = bSelectedDirect ? FString() : Action->Name;
	PendingToolName = ToolName;
	PendingActionName = ActionName;
	PendingCallId.Reset();
	bRequestInFlight = true;
	SetCallStatus(
		EUEVCallStatus::Running,
		bDryRunRequested ? TEXT("Running dry run...") : TEXT("Running..."));
	const TWeakPtr<SUEVControlPanel> WeakPanel = StaticCastSharedRef<SUEVControlPanel>(SharedThis(this));
	Client->CallTool(ToolName, ActionName, Params, [WeakPanel, CallKey](const FUEVControlCallResult& Result)
	{
		if (const TSharedPtr<SUEVControlPanel> This = WeakPanel.Pin())
		{
			This->bRequestInFlight = false;
			This->PendingCallId.Reset();
			if (Result.bAbandoned)
			{
				This->ResultText = This->FormatAbandonedResult(Result);
				if (This->ResultEditor.IsValid())
				{
					This->ResultEditor->SetText(FText::FromString(This->ResultText));
				}
				This->SetCallStatus(
					EUEVCallStatus::Abandoned,
					TEXT("Abandoned by client (applied=false). The editor action may still be running."));
				This->RefreshHistory();
				return;
			}

			const bool bUnsupported = Result.Code == TEXT("dry_run_unsupported");
			if (bUnsupported)
			{
				This->UnsupportedReasons.Add(CallKey, Result.Error);
				This->bDryRunRequested = false;
			}

			This->ResultText = !Result.Text.IsEmpty() ? Result.Text : Result.Error;
			if (This->ResultText.IsEmpty())
			{
				This->ResultText = Result.bOk ? TEXT("(empty response)") : TEXT("Request failed.");
			}
			if (Result.bDryRun && !bUnsupported)
			{
				This->ResultText = This->FormatDryRunResult(This->ResultText);
			}
			if (This->ResultEditor.IsValid())
			{
				This->ResultEditor->SetText(FText::FromString(This->ResultText));
			}

			const bool bTextFailure =
				Result.Text.Contains(TEXT("\"success\": false")) || Result.Text.Contains(TEXT("\"success\":false"));
			const bool bSuccess = Result.bOk && !bTextFailure && !bUnsupported;
			if (bUnsupported)
			{
				This->SetCallStatus(
					EUEVCallStatus::Warning,
					FString::Printf(TEXT("dry_run_unsupported: %s"), *Result.Error));
			}
			else if (Result.bDryRun && bSuccess)
			{
				This->SetCallStatus(
					EUEVCallStatus::Success,
					FString::Printf(TEXT("Dry run done in %.0f ms. Nothing was applied."), Result.DurationMs));
			}
			else
			{
				This->SetCallStatus(
					bSuccess ? EUEVCallStatus::Success : EUEVCallStatus::Failure,
					bSuccess ? FString::Printf(TEXT("Done in %.0f ms."), Result.DurationMs)
							 : (Result.Error.IsEmpty() ? TEXT("Call failed.") : Result.Error));
			}
			This->RefreshHistory();
		}
	});

	return FReply::Handled();
}

FReply SUEVControlPanel::OnRefreshClicked()
{
	RefreshAll();
	return FReply::Handled();
}

FReply SUEVControlPanel::OnControlToggleClicked()
{
	FUEVControlPanelModule* Module = FModuleManager::GetModulePtr<FUEVControlPanelModule>(TEXT("UEVControlPanel"));
	if (!Module)
	{
		SetCallStatus(EUEVCallStatus::Failure, TEXT("UEVControlPanel module is unavailable."));
		return FReply::Handled();
	}

	if (Module->IsControlServerOwned())
	{
		Module->StopControlServer();
		bControlStartRequested = false;
		bConnected = false;
		bHealthInFlight = false;
		Health = FUEVControlHealth();
		if (Client.IsValid())
		{
			Client->LoadDescriptor();
		}
		SetCallStatus(EUEVCallStatus::Warning, TEXT("UEV control stopped."));
		UpdateConnectionText();
		return FReply::Handled();
	}

	if (bConnected)
	{
		SetCallStatus(EUEVCallStatus::Success, TEXT("UEV control is already online."));
		return FReply::Handled();
	}

	FString Error;
	if (!Module->StartControlServer(Error))
	{
		SetCallStatus(EUEVCallStatus::Failure, Error);
		return FReply::Handled();
	}

	bControlStartRequested = true;
	ControlStartRequestTime = FPlatformTime::Seconds();
	LastHealthPoll = 0.0;
	SetCallStatus(EUEVCallStatus::Warning, TEXT("Starting UEV control..."));
	UpdateConnectionText();
	return FReply::Handled();
}

FReply SUEVControlPanel::OnSupervisorClicked()
{
	if (Health.SupervisorStatus.Equals(TEXT("connected"), ESearchCase::IgnoreCase))
	{
		SetCallStatus(EUEVCallStatus::Success, TEXT("Supervisor is already connected."));
		return FReply::Handled();
	}

	const FText Title = FText::FromString(TEXT("Start UEV Supervisor"));
	const FText Message = FText::FromString(
		TEXT("The supervisor must launch the editor so it can own the process. ")
		TEXT("Save your work, then close this editor. The supervisor and a supervised editor will start automatically.\n\n")
		TEXT("This button does not close the editor for you.\n\nStart the supervisor after this editor closes?"));
	if (FMessageDialog::Open(EAppMsgType::YesNo, Message, &Title) != EAppReturnType::Yes)
	{
		return FReply::Handled();
	}

	if (!Client.IsValid())
	{
		SetCallStatus(EUEVCallStatus::Failure, TEXT("UEV client is unavailable."));
		return FReply::Handled();
	}

	const FString DescriptorPath = Client->GetDescriptorPath();
	const FString InstallRoot = FPaths::GetPath(DescriptorPath);
	const FString SupervisorPath = FPaths::ConvertRelativePathToFull(
		FPaths::Combine(InstallRoot, TEXT("supervisor"), TEXT("UEVSupervisor.exe")));
	const FString SupervisorDir = FPaths::GetPath(SupervisorPath);
	const FString EntryPath = FPaths::ConvertRelativePathToFull(
		FPaths::Combine(InstallRoot, TEXT("app"), TEXT("dist"), TEXT("bin.js")));
	const FString NodePath = FPaths::ConvertRelativePathToFull(
		FPaths::Combine(InstallRoot, TEXT("node"), TEXT("node.exe")));
	const FString EditorPath = FPaths::ConvertRelativePathToFull(
		FPaths::Combine(FPaths::EngineDir(), TEXT("Binaries"), TEXT("Win64"), TEXT("UE4Editor.exe")));
	const FString ProjectPath = FPaths::ConvertRelativePathToFull(FPaths::GetProjectFilePath());
	for (const FString& Required : { SupervisorPath, EntryPath, NodePath, EditorPath, ProjectPath })
	{
		if (!IFileManager::Get().FileExists(*Required))
		{
			SetCallStatus(EUEVCallStatus::Failure, FString::Printf(TEXT("Supervisor launch path missing: %s"), *Required));
			return FReply::Handled();
		}
	}

	auto EscapePowerShell = [](const FString& Value)
	{
		return Value.Replace(TEXT("'"), TEXT("''"));
	};
	auto EscapeXml = [](const FString& Value)
	{
		return Value
			.Replace(TEXT("&"), TEXT("&amp;"))
			.Replace(TEXT("<"), TEXT("&lt;"))
			.Replace(TEXT(">"), TEXT("&gt;"))
			.Replace(TEXT("\""), TEXT("&quot;"));
	};

	const uint32 EditorPid = FPlatformProcess::GetCurrentProcessId();
	const FString TaskName = FString::Printf(TEXT("UEVSupervisorHandoff-%u"), EditorPid);
	const int32 ControlPort = Client->GetDescriptor().Port > 0 ? Client->GetDescriptor().Port : 8765;
	const FString Arguments = FString::Printf(
		TEXT("--editor \"%s\" --project \"%s\" --pipe \"uev-supervisor\" --control-api --mcp-entry \"%s\" --mcp-node \"%s\" --mcp-profile supervised --control-port %d"),
		*EditorPath,
		*ProjectPath,
		*EntryPath,
		*NodePath,
		ControlPort);

	const FString ScriptDirectory = FPaths::ConvertRelativePathToFull(
		FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UEV")));
	const FString ScriptPath = FPaths::Combine(ScriptDirectory, TEXT("start-supervisor-after-exit.ps1"));
	const FString HandoffLogPath = FPaths::Combine(ScriptDirectory, TEXT("supervisor-handoff.log"));
	const FString TaskXmlPath = FPaths::Combine(ScriptDirectory, TEXT("supervisor-handoff-task.xml"));
	IFileManager::Get().MakeDirectory(*ScriptDirectory, true);

	const FString Script = FString::Printf(
		TEXT("$ErrorActionPreference = 'Stop'\n")
		TEXT("$logPath = '%s'\n")
		TEXT("function Write-HandoffLog([string]$Message) { try { Add-Content -LiteralPath $logPath -Value ((Get-Date).ToString('o') + ' ' + $Message) } catch {} }\n")
		TEXT("$taskName = '%s'\n")
		TEXT("try {\n")
		TEXT("    Write-HandoffLog 'armed; waiting for editor pid %u'\n")
		TEXT("    Wait-Process -Id %u -ErrorAction SilentlyContinue\n")
		TEXT("    Write-HandoffLog 'editor exited; waiting 3 seconds'\n")
		TEXT("    Start-Sleep -Seconds 3\n")
		TEXT("    Start-Process -FilePath '%s' -WorkingDirectory '%s' -WindowStyle Normal -ArgumentList '%s'\n")
		TEXT("    Write-HandoffLog 'supervisor started'\n")
		TEXT("} catch {\n")
		TEXT("    Write-HandoffLog ('failed: ' + $_.Exception.Message)\n")
		TEXT("} finally {\n")
		TEXT("    try { & schtasks.exe /Delete /TN $taskName /F | Out-Null } catch {}\n")
		TEXT("    try { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue } catch {}\n")
		TEXT("    try { Remove-Item -LiteralPath (Join-Path $PSScriptRoot 'supervisor-handoff-task.xml') -Force -ErrorAction SilentlyContinue } catch {}\n")
		TEXT("}\n"),
		*EscapePowerShell(HandoffLogPath),
		*TaskName,
		EditorPid,
		EditorPid,
		*EscapePowerShell(SupervisorPath),
		*EscapePowerShell(SupervisorDir),
		*EscapePowerShell(Arguments));
	if (!FFileHelper::SaveStringToFile(Script, *ScriptPath))
	{
		SetCallStatus(EUEVCallStatus::Failure, FString::Printf(TEXT("Could not write %s"), *ScriptPath));
		return FReply::Handled();
	}

	const FString ActionArguments = FString::Printf(
		TEXT("-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"%s\""),
		*ScriptPath);
	const FString TaskXml = FString::Printf(
		TEXT("<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n")
		TEXT("<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\n")
		TEXT("  <RegistrationInfo><Description>UEV supervisor handoff</Description></RegistrationInfo>\n")
		TEXT("  <Triggers />\n")
		TEXT("  <Principals><Principal id=\"Author\"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>\n")
		TEXT("  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT1H</ExecutionTimeLimit><Priority>7</Priority></Settings>\n")
		TEXT("  <Actions Context=\"Author\"><Exec><Command>powershell.exe</Command><Arguments>%s</Arguments></Exec></Actions>\n")
		TEXT("</Task>\n"),
		*EscapeXml(ActionArguments));
	if (!FFileHelper::SaveStringToFile(TaskXml, *TaskXmlPath, FFileHelper::EEncodingOptions::ForceUnicode))
	{
		SetCallStatus(EUEVCallStatus::Failure, FString::Printf(TEXT("Could not write %s"), *TaskXmlPath));
		return FReply::Handled();
	}

	auto RunSchtasks = [](const FString& Parameters, FString& OutError)
	{
		int32 ReturnCode = 0;
		FString StdOut;
		FString StdErr;
		if (!FPlatformProcess::ExecProcess(TEXT("schtasks.exe"), *Parameters, &ReturnCode, &StdOut, &StdErr))
		{
			OutError = TEXT("Could not run schtasks.exe.");
			return false;
		}
		if (ReturnCode == 0)
		{
			return true;
		}
		OutError = StdErr.IsEmpty() ? StdOut : StdErr;
		OutError.TrimStartAndEndInline();
		if (OutError.IsEmpty())
		{
			OutError = FString::Printf(TEXT("schtasks.exe exited with code %d."), ReturnCode);
		}
		return false;
	};

	FString TaskError;
	const FString CreateTaskArgs = FString::Printf(
		TEXT("/Create /TN \"%s\" /XML \"%s\" /F"),
		*TaskName,
		*TaskXmlPath);
	if (!RunSchtasks(CreateTaskArgs, TaskError))
	{
		SetCallStatus(EUEVCallStatus::Failure, FString::Printf(TEXT("Could not create supervisor handoff task: %s"), *TaskError));
		return FReply::Handled();
	}

	const FString RunTaskArgs = FString::Printf(TEXT("/Run /TN \"%s\""), *TaskName);
	if (!RunSchtasks(RunTaskArgs, TaskError))
	{
		FString Ignored;
		RunSchtasks(FString::Printf(TEXT("/Delete /TN \"%s\" /F"), *TaskName), Ignored);
		SetCallStatus(EUEVCallStatus::Failure, FString::Printf(TEXT("Could not start supervisor handoff task: %s"), *TaskError));
		return FReply::Handled();
	}

	SetCallStatus(
		EUEVCallStatus::Warning,
		TEXT("Supervisor armed. Save your work and close the editor; the supervised stack will start automatically."));
	return FReply::Handled();
}

FReply SUEVControlPanel::OnHistoryClicked()
{
	RefreshHistory();
	return FReply::Handled();
}

FReply SUEVControlPanel::OnVerifyClicked()
{
	if (!Client.IsValid())
	{
		SetCallStatus(EUEVCallStatus::Failure, TEXT("UEV client is unavailable."));
		return FReply::Handled();
	}

	const FString InstallRoot = FPaths::GetPath(Client->GetDescriptorPath());
	const FString ScriptPath = FPaths::Combine(InstallRoot, TEXT("installer"), TEXT("install.ps1"));
	if (!IFileManager::Get().FileExists(*ScriptPath))
	{
		SetCallStatus(
			EUEVCallStatus::Failure,
			FString::Printf(TEXT("Verification script missing: %s. Reinstall the package."), *ScriptPath));
		return FReply::Handled();
	}

	const FString ProjectPath = FPaths::ConvertRelativePathToFull(FPaths::GetProjectFilePath());
	const FString Arguments = FString::Printf(
		TEXT("-NoProfile -ExecutionPolicy Bypass -File \"%s\" -Verify -Project \"%s\""),
		*ScriptPath,
		*ProjectPath);

	int32 ReturnCode = -1;
	FString StdOut;
	FString StdErr;
	const bool bLaunched = FPlatformProcess::ExecProcess(
		TEXT("powershell.exe"),
		*Arguments,
		&ReturnCode,
		&StdOut,
		&StdErr);

	FString Output = StdOut.TrimStartAndEnd();
	const FString ErrorOutput = StdErr.TrimStartAndEnd();
	if (!ErrorOutput.IsEmpty())
	{
		if (!Output.IsEmpty())
		{
			Output += TEXT("\n");
		}
		Output += ErrorOutput;
	}
	if (!bLaunched)
	{
		Output = TEXT("Failed to launch powershell.exe.");
	}
	if (Output.IsEmpty())
	{
		Output = FString::Printf(TEXT("Verification exit code: %d"), ReturnCode);
	}

	ResultText = Output;
	if (ResultEditor.IsValid())
	{
		ResultEditor->SetText(FText::FromString(ResultText));
	}
	const bool bSuccess = bLaunched && ReturnCode == 0;
	SetCallStatus(
		bSuccess ? EUEVCallStatus::Success : EUEVCallStatus::Failure,
		bSuccess ? TEXT("Install verification passed.") : TEXT("Install verification failed."));
	return FReply::Handled();
}

FReply SUEVControlPanel::OnPanicClicked()
{
	if (!Client.IsValid() || !bConnected)
	{
		SetCallStatus(EUEVCallStatus::Failure, TEXT("Control API is offline."));
		return FReply::Handled();
	}

	const FText Title = FText::FromString(TEXT("Confirm Panic"));
	const FText Message = FText::FromString(TEXT("Send a panic to the supervisor? This kills the editor job."));
	if (FMessageDialog::Open(EAppMsgType::YesNo, Message, &Title) != EAppReturnType::Yes)
	{
		return FReply::Handled();
	}

	SetCallStatus(EUEVCallStatus::Warning, TEXT("Sending panic..."));
	const TWeakPtr<SUEVControlPanel> WeakPanel = StaticCastSharedRef<SUEVControlPanel>(SharedThis(this));
	Client->Panic(TEXT("Control panel panic"), [WeakPanel](const bool bOk, const FString& MessageText)
	{
		if (const TSharedPtr<SUEVControlPanel> This = WeakPanel.Pin())
		{
			This->SetCallStatus(
				bOk ? EUEVCallStatus::Warning : EUEVCallStatus::Failure,
				bOk ? TEXT("Panic sent to supervisor.")
					: (MessageText.IsEmpty() ? TEXT("Panic failed.") : MessageText));
		}
	});

	return FReply::Handled();
}

FReply SUEVControlPanel::OnUndoClicked()
{
	const FUEVControlHistoryEntry* Entry = GetSelectedHistoryEntry();
	if (!Entry || !Client.IsValid())
	{
		SetCallStatus(EUEVCallStatus::Warning, TEXT("Select a history entry first."));
		return FReply::Handled();
	}

	const FString EntryId = Entry->Id;
	const FString EntryTool = Entry->Tool;
	const FString EntryAction = Entry->Action;
	const FText Title = FText::FromString(TEXT("Confirm Undo"));
	const FText Message = FText::FromString(FString::Printf(
		TEXT("Undo %s.%s?\n\nHistory id: %s"),
		*EntryTool,
		*EntryAction,
		*EntryId));
	if (FMessageDialog::Open(EAppMsgType::YesNo, Message, &Title) != EAppReturnType::Yes)
	{
		return FReply::Handled();
	}

	TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
	Params->SetStringField(TEXT("targetId"), EntryId);
	SetCallStatus(EUEVCallStatus::Running, TEXT("Undoing..."));
	const TWeakPtr<SUEVControlPanel> WeakPanel = StaticCastSharedRef<SUEVControlPanel>(SharedThis(this));
	Client->CallTool(TEXT("manage_history"), TEXT("undo"), Params, [WeakPanel](const FUEVControlCallResult& Result)
	{
		if (const TSharedPtr<SUEVControlPanel> This = WeakPanel.Pin())
		{
			This->ResultText = !Result.Text.IsEmpty() ? Result.Text : Result.Error;
			if (This->ResultEditor.IsValid())
			{
				This->ResultEditor->SetText(FText::FromString(This->ResultText));
			}
			const bool bTextFailure =
				Result.Text.Contains(TEXT("\"success\": false")) || Result.Text.Contains(TEXT("\"success\":false"));
			const bool bSuccess = Result.bOk && !bTextFailure;
			This->SetCallStatus(
				bSuccess ? EUEVCallStatus::Success : EUEVCallStatus::Failure,
				bSuccess ? TEXT("Undo sent.") : TEXT("Undo failed."));
			This->RefreshHistory();
		}
	});

	return FReply::Handled();
}

FReply SUEVControlPanel::OnRedoClicked()
{
	const FUEVControlHistoryEntry* Entry = GetSelectedHistoryEntry();
	if (!Entry || !Client.IsValid())
	{
		SetCallStatus(EUEVCallStatus::Warning, TEXT("Select a history entry first."));
		return FReply::Handled();
	}

	const FString EntryId = Entry->Id;
	const FString EntryTool = Entry->Tool;
	const FString EntryAction = Entry->Action;
	const FText Title = FText::FromString(TEXT("Confirm Redo"));
	const FText Message = FText::FromString(FString::Printf(
		TEXT("Redo %s.%s?\n\nHistory id: %s"),
		*EntryTool,
		*EntryAction,
		*EntryId));
	if (FMessageDialog::Open(EAppMsgType::YesNo, Message, &Title) != EAppReturnType::Yes)
	{
		return FReply::Handled();
	}

	TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
	Params->SetStringField(TEXT("targetId"), EntryId);
	SetCallStatus(EUEVCallStatus::Running, TEXT("Redoing..."));
	const TWeakPtr<SUEVControlPanel> WeakPanel = StaticCastSharedRef<SUEVControlPanel>(SharedThis(this));
	Client->CallTool(TEXT("manage_history"), TEXT("redo"), Params, [WeakPanel](const FUEVControlCallResult& Result)
	{
		if (const TSharedPtr<SUEVControlPanel> This = WeakPanel.Pin())
		{
			This->ResultText = !Result.Text.IsEmpty() ? Result.Text : Result.Error;
			if (This->ResultEditor.IsValid())
			{
				This->ResultEditor->SetText(FText::FromString(This->ResultText));
			}
			const bool bTextFailure =
				Result.Text.Contains(TEXT("\"success\": false")) || Result.Text.Contains(TEXT("\"success\":false"));
			const bool bSuccess = Result.bOk && !bTextFailure;
			This->SetCallStatus(
				bSuccess ? EUEVCallStatus::Success : EUEVCallStatus::Failure,
				bSuccess ? TEXT("Redo sent.") : TEXT("Redo failed."));
			This->RefreshHistory();
		}
	});

	return FReply::Handled();
}

FReply SUEVControlPanel::OnCopyResultClicked()
{
	FPlatformApplicationMisc::ClipboardCopy(*ResultText);
	StatusMessage = TEXT("Result copied.");
	UpdateStatusText();
	return FReply::Handled();
}

FString SUEVControlPanel::GetParamText(const TSharedPtr<FJsonObject>& Params, const FString& Name) const
{
	if (!Params.IsValid())
	{
		return FString();
	}
	const TSharedPtr<FJsonValue> Value = Params->TryGetField(Name);
	if (!Value.IsValid())
	{
		return FString();
	}
	if (Value->Type == EJson::String)
	{
		return Value->AsString();
	}
	if (Value->Type == EJson::Number)
	{
		return FString::SanitizeFloat(Value->AsNumber());
	}
	if (Value->Type == EJson::Boolean)
	{
		return Value->AsBool() ? TEXT("true") : TEXT("false");
	}
	return FString();
}

bool SUEVControlPanel::GetParamBool(const TSharedPtr<FJsonObject>& Params, const FString& Name, bool bDefault) const
{
	bool bValue = bDefault;
	if (Params.IsValid())
	{
		Params->TryGetBoolField(Name, bValue);
	}
	return bValue;
}

void SUEVControlPanel::SetParamValue(const FString& Name, const TSharedPtr<FJsonValue>& Value)
{
	FUEVParamTarget Target;
	Target.Scope = EUEVParamScope::TopLevel;
	Target.ParamName = Name;
	SetTargetValue(Target, Value);
}

bool SUEVControlPanel::ParseParams(TSharedPtr<FJsonObject>& OutParams) const
{
	const FString Trimmed = ParamsJson.TrimStartAndEnd();
	if (Trimmed.IsEmpty())
	{
		OutParams = MakeShared<FJsonObject>();
		return true;
	}
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Trimmed);
	if (!FJsonSerializer::Deserialize(Reader, OutParams) || !OutParams.IsValid())
	{
		OutParams = MakeShared<FJsonObject>();
		return false;
	}
	return true;
}

void SUEVControlPanel::CommitParams(const TSharedPtr<FJsonObject>& Params)
{
	if (!Params.IsValid())
	{
		return;
	}
	FString Text;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Text);
	FJsonSerializer::Serialize(Params.ToSharedRef(), Writer);
	ParamsJson = Text;
	if (ParamsEditor.IsValid() && !ParamsEditor->HasKeyboardFocus())
	{
		ParamsEditor->SetText(FText::FromString(ParamsJson));
	}
	RefreshRawParamEditors();
}

bool SUEVControlPanel::GetTargetValue(
	const TSharedPtr<FJsonObject>& Params,
	const FUEVParamTarget& Target,
	TSharedPtr<FJsonValue>& OutValue) const
{
	OutValue.Reset();
	if (!Params.IsValid() || Target.ParamName.IsEmpty())
	{
		return false;
	}
	const TSharedPtr<FJsonValue> RootValue = Params->TryGetField(Target.ParamName);
	if (!RootValue.IsValid())
	{
		return false;
	}
	if (Target.Scope == EUEVParamScope::TopLevel)
	{
		OutValue = RootValue;
		return true;
	}
	if (Target.Scope == EUEVParamScope::Element)
	{
		if (RootValue->Type != EJson::Array)
		{
			return false;
		}
		const TArray<TSharedPtr<FJsonValue>>& Items = RootValue->AsArray();
		if (!Items.IsValidIndex(Target.ArrayIndex))
		{
			return false;
		}
		if (Target.PropertyName.IsEmpty())
		{
			OutValue = Items[Target.ArrayIndex];
			return true;
		}
		// A field inside an array element ("conditions[0].kind"): walk the dotted path inside the element object.
		const TSharedPtr<FJsonValue> ElementValue = Items[Target.ArrayIndex];
		const TSharedPtr<FJsonObject>* ElementObject = nullptr;
		if (!ElementValue.IsValid() || ElementValue->Type != EJson::Object || !ElementValue->TryGetObject(ElementObject) ||
			!ElementObject || !ElementObject->IsValid())
		{
			return false;
		}
		return GetObjectPathValue(*ElementObject, Target.PropertyName, OutValue);
	}

	const TSharedPtr<FJsonObject>* RootObject = nullptr;
	if (RootValue->Type != EJson::Object || !RootValue->TryGetObject(RootObject) || !RootObject || !RootObject->IsValid())
	{
		return false;
	}
	return GetObjectPathValue(*RootObject, Target.PropertyName, OutValue);
}

void SUEVControlPanel::SetTargetValue(const FUEVParamTarget& Target, const TSharedPtr<FJsonValue>& Value)
{
	if (Target.ParamName.IsEmpty())
	{
		return;
	}

	TSharedPtr<FJsonObject> Params;
	ParseParams(Params);
	if (!Params.IsValid())
	{
		return;
	}

	if (Target.Scope == EUEVParamScope::TopLevel)
	{
		if (Value.IsValid())
		{
			Params->SetField(Target.ParamName, Value);
		}
		else
		{
			Params->RemoveField(Target.ParamName);
		}
	}
	else if (Target.Scope == EUEVParamScope::Element)
	{
		const TSharedPtr<FJsonValue> RootValue = Params->TryGetField(Target.ParamName);
		TArray<TSharedPtr<FJsonValue>> Items;
		if (RootValue.IsValid() && RootValue->Type == EJson::Array)
		{
			Items = RootValue->AsArray();
		}
		if (Target.PropertyName.IsEmpty())
		{
			if (Target.ArrayIndex == INDEX_NONE)
			{
				Items.Add(Value.IsValid() ? Value : MakeShared<FJsonValueNull>());
			}
			else if (Items.IsValidIndex(Target.ArrayIndex))
			{
				if (Value.IsValid())
				{
					Items[Target.ArrayIndex] = Value;
				}
				else
				{
					Items.RemoveAt(Target.ArrayIndex);
				}
			}
		}
		else
		{
			// A field inside an element ("conditions[0].kind"): append a fresh object when the row is new, otherwise
			// edit the existing element object in place.
			int32 ElementIndex = Target.ArrayIndex;
			if (ElementIndex == INDEX_NONE)
			{
				ElementIndex = Items.Add(MakeShared<FJsonValueObject>(MakeShared<FJsonObject>()));
			}
			if (Items.IsValidIndex(ElementIndex))
			{
				TSharedPtr<FJsonObject> ElementObject;
				if (Items[ElementIndex].IsValid() && Items[ElementIndex]->Type == EJson::Object)
				{
					ElementObject = Items[ElementIndex]->AsObject();
				}
				if (!ElementObject.IsValid())
				{
					ElementObject = MakeShared<FJsonObject>();
				}
				SetObjectPathValue(ElementObject, Target.PropertyName, Value);
				Items[ElementIndex] = MakeShared<FJsonValueObject>(ElementObject);
			}
		}
		Params->SetArrayField(Target.ParamName, Items);
	}
	else
	{
		if (Target.PropertyName.IsEmpty())
		{
			return;
		}

		const TSharedPtr<FJsonValue> RootValue = Params->TryGetField(Target.ParamName);
		const TSharedPtr<FJsonObject>* ExistingRoot = nullptr;
		TSharedPtr<FJsonObject> Root =
			(RootValue.IsValid() && RootValue->Type == EJson::Object && RootValue->TryGetObject(ExistingRoot) && ExistingRoot && ExistingRoot->IsValid())
				? *ExistingRoot
				: MakeShared<FJsonObject>();

		SetObjectPathValue(Root, Target.PropertyName, Value);
		Params->SetObjectField(Target.ParamName, Root);
	}

	CommitParams(Params);
}

void SUEVControlPanel::RefreshRawParamEditor(const FString& ParamName)
{
	const TSharedPtr<SMultiLineEditableTextBox>* EditorPtr = RawParamEditors.Find(ParamName);
	if (!EditorPtr || !EditorPtr->IsValid())
	{
		return;
	}
	if ((*EditorPtr)->HasKeyboardFocus())
	{
		return;
	}
	TSharedPtr<FJsonObject> Params;
	ParseParams(Params);
	FUEVParamTarget Target;
	Target.Scope = EUEVParamScope::TopLevel;
	Target.ParamName = ParamName;
	TSharedPtr<FJsonValue> Value;
	GetTargetValue(Params, Target, Value);
	(*EditorPtr)->SetText(FText::FromString(SerializeParamValue(Value)));
}

void SUEVControlPanel::RefreshRawParamEditors()
{
	for (const TPair<FString, TSharedPtr<SMultiLineEditableTextBox>>& Pair : RawParamEditors)
	{
		RefreshRawParamEditor(Pair.Key);
	}
}

TSharedPtr<FJsonValue> SUEVControlPanel::MakeDefaultValue(const FUEVParamInfo& Param) const
{
	if (Param.EnumValues.Num() > 0)
	{
		return MakeShared<FJsonValueString>(Param.EnumValues[0]);
	}
	if (Param.Type == TEXT("string"))
	{
		return MakeShared<FJsonValueString>(FString());
	}
	if (Param.Type == TEXT("number") || Param.Type == TEXT("integer"))
	{
		return MakeShared<FJsonValueNumber>(0.0);
	}
	if (Param.Type == TEXT("boolean"))
	{
		return MakeShared<FJsonValueBoolean>(false);
	}
	if (Param.Type == TEXT("array"))
	{
		return MakeShared<FJsonValueArray>(TArray<TSharedPtr<FJsonValue>>());
	}
	if (Param.Type == TEXT("object"))
	{
		return MakeShared<FJsonValueObject>(MakeShared<FJsonObject>());
	}
	return MakeShared<FJsonValueNull>();
}

TSharedRef<SWidget> SUEVControlPanel::BuildValueEditor(
	const FUEVParamInfo& Param,
	const FUEVParamTarget& Target,
	const bool bCompact)
{
	const TWeakPtr<SUEVControlPanel> WeakPanel = StaticCastSharedRef<SUEVControlPanel>(SharedThis(this));

	TSharedPtr<FJsonObject> Params;
	ParseParams(Params);
	TSharedPtr<FJsonValue> CurrentValue;
	GetTargetValue(Params, Target, CurrentValue);
	const FString CurrentText = SerializeValueText(CurrentValue);
	const FString TargetLabel = DescribeParamTarget(Target);

	if (Param.EnumValues.Num() > 0)
	{
		TSharedPtr<TArray<TSharedPtr<FString>>> Options = MakeShared<TArray<TSharedPtr<FString>>>();
		TSharedPtr<FString> Selected;
		for (const FString& EnumValue : Param.EnumValues)
		{
			const TSharedPtr<FString> Option = MakeShared<FString>(EnumValue);
			Options->Add(Option);
			if (EnumValue.Equals(CurrentText, ESearchCase::IgnoreCase))
			{
				Selected = Option;
			}
		}
		const FString OptionKey = FString::Printf(TEXT("%s#%d"), *TargetLabel, ParamComboOptions.Num());
		ParamComboOptions.Add(OptionKey, Options);

		// SComboBox renders a "No Content Provided" warning unless a Content widget is supplied, so track the
		// current choice in a shared box and show it (or a placeholder while the parameter is unset).
		TSharedPtr<TSharedPtr<FString>> CurrentChoice = MakeShared<TSharedPtr<FString>>(Selected);
		return SNew(SComboBox<TSharedPtr<FString>>)
			.OptionsSource(Options.Get())
			.InitiallySelectedItem(Selected)
			.Content()
			[
				SNew(STextBlock)
				.Text_Lambda([CurrentChoice, TargetLabel]()
				{
					const TSharedPtr<FString>& Choice = *CurrentChoice;
					return FText::FromString(Choice.IsValid() && !Choice->IsEmpty()
						? *Choice
						: FString::Printf(TEXT("<choose %s>"), *TargetLabel));
				})
				.ColorAndOpacity(FSlateColor(FLinearColor(0.72f, 0.72f, 0.72f)))
				.Font(FCoreStyle::GetDefaultFontStyle("Regular", 8))
			]
			.OnGenerateWidget_Lambda([](TSharedPtr<FString> Item)
			{
				return SNew(STextBlock).Text(FText::FromString(Item.IsValid() ? *Item : FString()));
			})
			.OnSelectionChanged_Lambda([WeakPanel, Target, CurrentChoice](TSharedPtr<FString> Item, ESelectInfo::Type)
			{
				*CurrentChoice = Item;
				if (const TSharedPtr<SUEVControlPanel> This = WeakPanel.Pin())
				{
					This->SetTargetValue(Target, MakeShared<FJsonValueString>(Item.IsValid() ? *Item : FString()));
				}
			});
	}

	if (Param.Type == TEXT("boolean"))
	{
		const bool bChecked = CurrentValue.IsValid() && CurrentValue->Type == EJson::Boolean && CurrentValue->AsBool();
		return SNew(SCheckBox)
			.IsChecked(bChecked ? ECheckBoxState::Checked : ECheckBoxState::Unchecked)
			.OnCheckStateChanged_Lambda([WeakPanel, Target](ECheckBoxState State)
			{
				if (const TSharedPtr<SUEVControlPanel> This = WeakPanel.Pin())
				{
					This->SetTargetValue(Target, MakeShared<FJsonValueBoolean>(State == ECheckBoxState::Checked));
				}
			});
	}

	if (Param.Type == TEXT("number") || Param.Type == TEXT("integer"))
	{
		return SNew(SEditableTextBox)
			.Text(FText::FromString(CurrentText))
			.OnTextCommitted_Lambda([WeakPanel, Target](const FText& Text, ETextCommit::Type)
			{
				const TSharedPtr<SUEVControlPanel> This = WeakPanel.Pin();
				if (!This.IsValid())
				{
					return;
				}
				const FString Value = Text.ToString().TrimStartAndEnd();
				if (Value.IsEmpty())
				{
					This->SetTargetValue(Target, nullptr);
					return;
				}
				if (!Value.IsNumeric())
				{
					This->SetCallStatus(
						EUEVCallStatus::Warning,
						FString::Printf(TEXT("%s must be numeric."), *DescribeParamTarget(Target)));
					return;
				}
				This->SetTargetValue(Target, MakeShared<FJsonValueNumber>(FCString::Atod(*Value)));
			});
	}

	if (Param.Type == TEXT("string") || Param.Type.IsEmpty() || Param.Type == TEXT("any"))
	{
		TSharedRef<SWidget> TextBox = SNew(SEditableTextBox)
			.Text(FText::FromString(CurrentText))
			.OnTextCommitted_Lambda([WeakPanel, Target](const FText& Text, ETextCommit::Type)
			{
				if (const TSharedPtr<SUEVControlPanel> This = WeakPanel.Pin())
				{
					const FString Value = Text.ToString();
					if (Value.IsEmpty())
					{
						This->SetTargetValue(Target, nullptr);
					}
					else
					{
						This->SetTargetValue(Target, MakeShared<FJsonValueString>(Value));
					}
				}
			});

		if (Target.Scope == EUEVParamScope::TopLevel && IsAssetPathParam(Param))
		{
			return SNew(SHorizontalBox)
				+ SHorizontalBox::Slot()
				.FillWidth(1.0f)
				[
					TextBox
				]
				+ SHorizontalBox::Slot()
				.AutoWidth()
				.Padding(4.0f, 0.0f, 0.0f, 0.0f)
				[
					SNew(SButton)
					.Text(FText::FromString(TEXT("Pick")))
					.ToolTipText(FText::FromString(TEXT("Search the project's assets and use the chosen asset path.")))
					.OnClicked_Lambda([WeakPanel, Param]()
					{
						if (const TSharedPtr<SUEVControlPanel> This = WeakPanel.Pin())
						{
							This->OpenAssetPicker(Param.Name);
						}
						return FReply::Handled();
					})
				];
		}
		return TextBox;
	}

	TSharedPtr<SMultiLineEditableTextBox> Editor;
	TSharedRef<SWidget> Box = SNew(SBox)
		.HeightOverride(bCompact ? 42.0f : 56.0f)
		[
			SAssignNew(Editor, SMultiLineEditableTextBox)
			.Font(FCoreStyle::GetDefaultFontStyle("Mono", 8))
			.Text(FText::FromString(SerializeParamValue(CurrentValue)))
			.AlwaysShowScrollbars(true)
			.OnTextCommitted_Lambda([WeakPanel, Target](const FText& Text, ETextCommit::Type)
			{
				const TSharedPtr<SUEVControlPanel> This = WeakPanel.Pin();
				if (!This.IsValid())
				{
					return;
				}
				const FString Json = Text.ToString().TrimStartAndEnd();
				if (Json.IsEmpty())
				{
					This->SetTargetValue(Target, nullptr);
					return;
				}
				const TSharedPtr<FJsonValue> Parsed = ParseControlPanelValue(Json);
				if (!Parsed.IsValid())
				{
					This->SetCallStatus(
						EUEVCallStatus::Warning,
						FString::Printf(TEXT("%s must be valid JSON."), *DescribeParamTarget(Target)));
					return;
				}
				This->SetTargetValue(Target, Parsed);
			})
		];

	if (Target.Scope == EUEVParamScope::TopLevel && !bCompact)
	{
		RawParamEditors.Add(TargetLabel, Editor);
	}
	return Box;
}

void SUEVControlPanel::AddParamRow(
	const TSharedRef<SVerticalBox>& Box,
	const FUEVParamInfo& Param,
	const FUEVParamTarget& Target,
	const bool bCompact)
{
	const TWeakPtr<SUEVControlPanel> WeakPanel = StaticCastSharedRef<SUEVControlPanel>(SharedThis(this));

	const FString Label = FString::Printf(
		TEXT("%s%s  %s"),
		(Target.Scope == EUEVParamScope::TopLevel && Param.bRequired) ? TEXT("* ") : TEXT(""),
		*DescribeParamTarget(Target),
		*DescribeParamType(Param));

	TSharedRef<SWidget> LabelWidget = SNew(STextBlock)
		.Text(FText::FromString(Label))
		.ToolTipText(FText::FromString(Param.Description.IsEmpty()
			? FString::Printf(TEXT("%s (%s)"), *Param.Name, *DescribeParamType(Param))
			: FString::Printf(TEXT("%s (%s)\n%s"), *Param.Name, *DescribeParamType(Param), *Param.Description)))
		.Font(FCoreStyle::GetDefaultFontStyle("Bold", 8))
		.ColorAndOpacity(FSlateColor(FLinearColor(0.78f, 0.78f, 0.78f)));

	if (Target.Scope == EUEVParamScope::Element)
	{
		LabelWidget = SNew(SHorizontalBox)
			+ SHorizontalBox::Slot()
			.FillWidth(1.0f)
			.VAlign(VAlign_Center)
			[
				LabelWidget
			]
			+ SHorizontalBox::Slot()
			.AutoWidth()
			.VAlign(VAlign_Center)
			.Padding(4.0f, 0.0f, 0.0f, 0.0f)
			[
				SNew(SButton)
				.Text(FText::FromString(TEXT("X")))
				.ToolTipText(FText::FromString(TEXT("Remove this element.")))
				.OnClicked_Lambda([WeakPanel, Target]()
				{
					if (const TSharedPtr<SUEVControlPanel> This = WeakPanel.Pin())
					{
						This->SetTargetValue(Target, nullptr);
						This->bFormRefreshPending = true;
					}
					return FReply::Handled();
				})
			];
	}

	Box->AddSlot()
		.AutoHeight()
		.Padding(0.0f, bCompact ? 1.0f : 3.0f, 0.0f, 1.0f)
		[
			LabelWidget
		];

	// Property targets address a dotted path inside the parameter object, and element targets address a dotted path
	// inside that array element, so declared objects expand wherever they sit: top level, inside a property, or
	// inside an array element ("conditions[0].kind").
	const bool bStructuredObject = Param.Type == TEXT("object") && Param.Properties.Num() > 0;
	// Open records (the catalog's bare "object", or a typed record via additionalProperties) get a key/value editor
	// instead of a raw JSON box.
	const bool bFreeFormObject = Param.Type == TEXT("object") && Param.Properties.Num() == 0;
	// Arrays can only be indexed from the parameter root (element targets carry a slot, not a property path), so a
	// nested array keeps the JSON editor and explains why.
	const bool bArrayEditable = Param.Type == TEXT("array") && Target.Scope == EUEVParamScope::TopLevel;
	const bool bJsonFallback = (Param.Type == TEXT("object") || Param.Type == TEXT("array")) &&
		!bStructuredObject && !bFreeFormObject && !bArrayEditable;
	if (!bStructuredObject && !bFreeFormObject)
	{
		Box->AddSlot()
			.AutoHeight()
			.Padding(0.0f, 0.0f, 0.0f, bCompact ? 2.0f : 5.0f)
			[
				BuildValueEditor(Param, Target, bCompact)
			];
		if (bJsonFallback)
		{
			Box->AddSlot()
				.AutoHeight()
				.Padding(2.0f, 0.0f, 0.0f, 4.0f)
				[
					SNew(STextBlock)
					.Text(FText::FromString(FString::Printf(
						TEXT("Nested %s: edit it as JSON above. Element editors are available for top-level array parameters."),
						*Param.Type)))
					.Font(FCoreStyle::GetDefaultFontStyle("Regular", 7))
					.ColorAndOpacity(FSlateColor(FLinearColor(0.55f, 0.55f, 0.55f)))
					.AutoWrapText(true)
				];
		}
	}
	else if (bFreeFormObject)
	{
		TSharedPtr<FJsonObject> Params;
		ParseParams(Params);
		TSharedPtr<FJsonValue> ObjectValue;
		GetTargetValue(Params, Target, ObjectValue);
		TArray<FString> Keys;
		if (ObjectValue.IsValid() && ObjectValue->Type == EJson::Object)
		{
			for (const TPair<FString, TSharedPtr<FJsonValue>>& Pair : ObjectValue->AsObject()->Values)
			{
				Keys.Add(Pair.Key);
			}
		}
		Keys.Sort();

		// A typed record (the catalog's additionalProperties) tells us what each key's value looks like, so the
		// key/value editor can use a real typed editor instead of a free-text box.
		FUEVParamInfo KeyTemplate;
		KeyTemplate.Name = TEXT("value");
		KeyTemplate.Type = TEXT("any");
		if (Param.AdditionalProperties.IsValid())
		{
			KeyTemplate = *Param.AdditionalProperties;
			KeyTemplate.Name = TEXT("value");
		}

		if (Keys.Num() == 0)
		{
			Box->AddSlot()
				.AutoHeight()
				.Padding(0.0f, 0.0f, 0.0f, 2.0f)
				[
					SNew(STextBlock)
					.Text(FText::FromString(TEXT("No keys yet. Add keys below, or edit the JSON params directly.")))
					.Font(FCoreStyle::GetDefaultFontStyle("Regular", 8))
					.ColorAndOpacity(FSlateColor(FLinearColor(0.6f, 0.6f, 0.6f)))
				];
		}
		if (Param.AdditionalProperties.IsValid())
		{
			Box->AddSlot()
				.AutoHeight()
				.Padding(0.0f, 0.0f, 0.0f, 2.0f)
				[
					SNew(STextBlock)
					.Text(FText::FromString(FString::Printf(
						TEXT("Record values are %s."),
						*DescribeParamType(KeyTemplate))))
					.Font(FCoreStyle::GetDefaultFontStyle("Regular", 7))
					.ColorAndOpacity(FSlateColor(FLinearColor(0.55f, 0.55f, 0.55f)))
				];
		}

		for (const FString& Key : Keys)
		{
			FUEVParamInfo KeyParam = KeyTemplate;
			KeyParam.Name = Key;
			FUEVParamTarget KeyTarget = Target;
			KeyTarget.Scope = (Target.Scope == EUEVParamScope::Element) ? EUEVParamScope::Element
																		: EUEVParamScope::Property;
			KeyTarget.PropertyName = Key;
			KeyTarget.ArrayIndex = (Target.Scope == EUEVParamScope::Element) ? Target.ArrayIndex : INDEX_NONE;

			Box->AddSlot()
				.AutoHeight()
				.Padding(0.0f, 0.0f, 0.0f, 2.0f)
				[
					SNew(SHorizontalBox)
					+ SHorizontalBox::Slot()
					.FillWidth(1.0f)
					.VAlign(VAlign_Center)
					[
						SNew(SHorizontalBox)
						+ SHorizontalBox::Slot()
						.FillWidth(0.4f)
						.VAlign(VAlign_Center)
						.Padding(0.0f, 0.0f, 4.0f, 0.0f)
						[
							SNew(STextBlock)
							.Text(FText::FromString(Key))
							.Font(FCoreStyle::GetDefaultFontStyle("Regular", 8))
						]
						+ SHorizontalBox::Slot()
						.FillWidth(0.6f)
						[
							BuildValueEditor(KeyParam, KeyTarget, true)
						]
					]
					+ SHorizontalBox::Slot()
					.AutoWidth()
					.VAlign(VAlign_Center)
					.Padding(4.0f, 0.0f, 0.0f, 0.0f)
					[
						SNew(SButton)
						.Text(FText::FromString(TEXT("X")))
						.ToolTipText(FText::FromString(FString::Printf(TEXT("Remove key %s."), *Key)))
						.OnClicked_Lambda([WeakPanel, KeyTarget]()
						{
							if (const TSharedPtr<SUEVControlPanel> This = WeakPanel.Pin())
							{
								This->SetTargetValue(KeyTarget, TSharedPtr<FJsonValue>());
								This->bFormRefreshPending = true;
							}
							return FReply::Handled();
						})
					]
				];
		}

		TSharedPtr<SEditableTextBox> NewKeyBox;
		Box->AddSlot()
			.AutoHeight()
			.Padding(0.0f, 2.0f, 0.0f, bCompact ? 2.0f : 6.0f)
			[
				SNew(SHorizontalBox)
				+ SHorizontalBox::Slot()
				.FillWidth(1.0f)
				[
					SAssignNew(NewKeyBox, SEditableTextBox)
					.HintText(FText::FromString(TEXT("New key name")))
					.Font(FCoreStyle::GetDefaultFontStyle("Regular", 8))
				]
				+ SHorizontalBox::Slot()
				.AutoWidth()
				.Padding(4.0f, 0.0f, 0.0f, 0.0f)
				[
					SNew(SButton)
					.Text(FText::FromString(TEXT("+ Add key")))
					.ToolTipText(FText::FromString(FString::Printf(TEXT("Add a key to %s."), *DescribeParamTarget(Target))))
					.OnClicked_Lambda([WeakPanel, Target, NewKeyBox, KeyTemplate]()
					{
						const TSharedPtr<SUEVControlPanel> This = WeakPanel.Pin();
						if (!This.IsValid() || !NewKeyBox.IsValid())
						{
							return FReply::Handled();
						}
						const FString NewKey = NewKeyBox->GetText().ToString().TrimStartAndEnd();
						if (NewKey.IsEmpty())
						{
							This->SetCallStatus(EUEVCallStatus::Warning, TEXT("Type a key name before adding it."));
							return FReply::Handled();
						}
						FUEVParamTarget AddTarget = Target;
						AddTarget.Scope = (Target.Scope == EUEVParamScope::Element) ? EUEVParamScope::Element
																					: EUEVParamScope::Property;
						AddTarget.PropertyName = NewKey;
						AddTarget.ArrayIndex = (Target.Scope == EUEVParamScope::Element) ? Target.ArrayIndex : INDEX_NONE;
						const TSharedPtr<FJsonValue> NewValue = KeyTemplate.Type == TEXT("any")
							? MakeShared<FJsonValueString>(FString())
							: This->MakeDefaultValue(KeyTemplate);
						This->SetTargetValue(AddTarget, NewValue);
						This->bFormRefreshPending = true;
						return FReply::Handled();
					})
				]
			];
	}
	else
	{
		for (const FUEVParamInfo& Property : Param.Properties)
		{
			FUEVParamTarget ChildTarget = Target;
			// Preserve the element context so a field inside an array element keeps addressing "conditions[0].kind".
			ChildTarget.Scope = (Target.Scope == EUEVParamScope::Element) ? EUEVParamScope::Element
																		: EUEVParamScope::Property;
			// A top-level parameter starts its path with the property name; a nested object appends to the parent path.
			ChildTarget.PropertyName = Target.PropertyName.IsEmpty()
				? Property.Name
				: FString::Printf(TEXT("%s.%s"), *Target.PropertyName, *Property.Name);
			// An element's fields must keep addressing that element; only a plain property path drops the index.
			ChildTarget.ArrayIndex = (Target.Scope == EUEVParamScope::Element) ? Target.ArrayIndex : INDEX_NONE;
			AddParamRow(Box, Property, ChildTarget, true);
		}
	}

	if (bArrayEditable)
	{
		FUEVParamInfo ElementParam;
		if (Param.bHasItems && Param.Items.IsValid())
		{
			ElementParam = *Param.Items;
		}
		else
		{
			ElementParam.Type = TEXT("any");
			ElementParam.Name = FString::Printf(TEXT("%s[]"), *Param.Name);
		}

		TSharedPtr<FJsonObject> Params;
		ParseParams(Params);
		TSharedPtr<FJsonValue> ArrayValue;
		GetTargetValue(Params, Target, ArrayValue);
		const int32 ElementCount =
			(ArrayValue.IsValid() && ArrayValue->Type == EJson::Array) ? ArrayValue->AsArray().Num() : 0;

		for (int32 Index = 0; Index < ElementCount; ++Index)
		{
			FUEVParamTarget ElementTarget = Target;
			ElementTarget.Scope = EUEVParamScope::Element;
			ElementTarget.ArrayIndex = Index;
			ElementTarget.PropertyName.Reset();
			AddParamRow(Box, ElementParam, ElementTarget, true);
		}

		Box->AddSlot()
			.AutoHeight()
			.Padding(0.0f, 0.0f, 0.0f, 6.0f)
			[
				SNew(SButton)
				.Text(FText::FromString(TEXT("+ Add element")))
				.ToolTipText(FText::FromString(FString::Printf(
					TEXT("Append an element to %s."),
					*DescribeParamTarget(Target))))
				.OnClicked_Lambda([WeakPanel, ElementParam, Target]()
				{
					if (const TSharedPtr<SUEVControlPanel> This = WeakPanel.Pin())
					{
						FUEVParamTarget AddTarget = Target;
						AddTarget.Scope = EUEVParamScope::Element;
						AddTarget.ArrayIndex = INDEX_NONE;
						AddTarget.PropertyName.Reset();
						This->SetTargetValue(AddTarget, This->MakeDefaultValue(ElementParam));
						This->bFormRefreshPending = true;
					}
					return FReply::Handled();
				})
			];
	}
}

void SUEVControlPanel::RebuildParamForm()
{
	// Crash guard (panel-reentrancy): same depth cap as RebuildToolRows.
	if (RebuildDepth >= MaxRebuildDepth)
	{
		UE_LOG(LogTemp, Warning, TEXT("UEV control panel: nested param form rebuild skipped at depth %d (panel-reentrancy crash guard)."), RebuildDepth);
		return;
	}
	struct FRebuildDepthGuard
	{
		int32& Depth;
		explicit FRebuildDepthGuard(int32& InDepth) : Depth(InDepth) { ++Depth; }
		~FRebuildDepthGuard() { --Depth; }
	} ParamFormGuard(RebuildDepth);

	if (!ParamFormBox.IsValid())
	{
		return;
	}
	ParamFormBox->ClearChildren();
	ParamRows.Reset();
	RawParamEditors.Reset();
	ParamComboOptions.Reset();

	const FUEVControlAction* Action = GetSelectedAction();
	if (!Action)
	{
		ParamFormBox->AddSlot()
			.AutoHeight()
			[
				SNew(STextBlock).Text(FText::FromString(TEXT("Select an action to generate its form.")))
			];
		return;
	}
	if (Action->Params.Num() == 0)
	{
		ParamFormBox->AddSlot()
			.AutoHeight()
			[
				SNew(STextBlock).Text(FText::FromString(TEXT("This action has no parameters.")))
			];
		return;
	}

	const TSharedRef<SVerticalBox> BoxRef = ParamFormBox.ToSharedRef();
	for (const FUEVParamInfo& Param : Action->Params)
	{
		FUEVParamTarget Target;
		Target.Scope = EUEVParamScope::TopLevel;
		Target.ParamName = Param.Name;
		AddParamRow(BoxRef, Param, Target, false);
	}
}

FString SUEVControlPanel::FormatParamsHint() const
{
	const FUEVControlAction* Action = GetSelectedAction();
	if (!Action)
	{
		return TEXT("Params: -");
	}
	if (Action->Params.Num() == 0)
	{
		return TEXT("Params: none");
	}

	FString Hint = TEXT("Params: ");
	for (int32 Index = 0; Index < Action->Params.Num(); ++Index)
	{
		const FUEVParamInfo& Param = Action->Params[Index];
		if (Index > 0)
		{
			Hint += TEXT(", ");
		}
		Hint += FString::Printf(TEXT("%s%s: %s"), *Param.Name, Param.bRequired ? TEXT("*") : TEXT(""), *Param.Type);
		if (Param.EnumValues.Num() > 0)
		{
			Hint += FString::Printf(TEXT(" (%s)"), *FString::Join(Param.EnumValues, TEXT("|")));
		}
	}
	return Hint;
}

FString SUEVControlPanel::BuildParamsTemplate() const
{
	const FUEVControlAction* Action = GetSelectedAction();
	if (!Action)
	{
		return TEXT("{}");
	}

	const TSharedPtr<FJsonObject> Template = MakeShared<FJsonObject>();
	for (const FUEVParamInfo& Param : Action->Params)
	{
		if (Param.Type == TEXT("string"))
		{
			Template->SetStringField(Param.Name, Param.EnumValues.Num() > 0 ? Param.EnumValues[0] : FString());
		}
		else if (Param.Type == TEXT("number"))
		{
			Template->SetNumberField(Param.Name, 0.0);
		}
		else if (Param.Type == TEXT("boolean"))
		{
			Template->SetBoolField(Param.Name, false);
		}
		else if (Param.Type == TEXT("array"))
		{
			Template->SetArrayField(Param.Name, TArray<TSharedPtr<FJsonValue>>());
		}
		else if (Param.Type == TEXT("object"))
		{
			Template->SetObjectField(Param.Name, MakeShared<FJsonObject>());
		}
		else
		{
			Template->SetField(Param.Name, MakeShared<FJsonValueNull>());
		}
	}

	FString Text;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Text);
	FJsonSerializer::Serialize(Template.ToSharedRef(), Writer);
	return Text;
}

FReply SUEVControlPanel::OnTemplateClicked()
{
	if (!GetSelectedAction())
	{
		SetCallStatus(EUEVCallStatus::Warning, TEXT("Select an action first."));
		return FReply::Handled();
	}

	ParamsJson = BuildParamsTemplate();
	if (ParamsEditor.IsValid())
	{
		ParamsEditor->SetText(FText::FromString(ParamsJson));
	}
	RebuildParamForm();
	SetCallStatus(EUEVCallStatus::Idle, TEXT("Inserted the params template."));
	return FReply::Handled();
}

FReply SUEVControlPanel::OnSyncFormClicked()
{
	RebuildParamForm();
	SetCallStatus(EUEVCallStatus::Idle, TEXT("Rebuilt the form from JSON params."));
	return FReply::Handled();
}

FReply SUEVControlPanel::OnCaptureUiClicked()
{
	if (!Client.IsValid() || !bConnected)
	{
		SetCallStatus(EUEVCallStatus::Failure, TEXT("Control API is offline."));
		return FReply::Handled();
	}

	TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
	Params->SetStringField(TEXT("window_title"), TEXT("UEV Control Panel"));
	SetCallStatus(EUEVCallStatus::Running, TEXT("Capturing the panel window..."));

	const TWeakPtr<SUEVControlPanel> WeakPanel = StaticCastSharedRef<SUEVControlPanel>(SharedThis(this));
	Client->CallTool(TEXT("editor_capture_window"), FString(), Params, [WeakPanel](const FUEVControlCallResult& Result)
	{
		if (const TSharedPtr<SUEVControlPanel> This = WeakPanel.Pin())
		{
			This->ResultText = !Result.Text.IsEmpty() ? Result.Text : Result.Error;
			if (This->ResultText.IsEmpty())
			{
				This->ResultText = Result.bOk ? TEXT("(empty response)") : TEXT("Capture failed.");
			}
			if (This->ResultEditor.IsValid())
			{
				This->ResultEditor->SetText(FText::FromString(This->ResultText));
			}
			This->SetCallStatus(
				Result.bOk ? EUEVCallStatus::Success : EUEVCallStatus::Failure,
				Result.bOk ? TEXT("UI capture saved.") : TEXT("UI capture failed."));
		}
	});

	return FReply::Handled();
}


FReply SUEVControlPanel::OnArtifactsClicked()
{
	const FString ScreenshotDir = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("Screenshots"), TEXT("Windows"));
	const FString ProfilingDir = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("Profiling"));

	TArray<FString> Screenshots;
	IFileManager::Get().FindFiles(Screenshots, *FPaths::Combine(ScreenshotDir, TEXT("*.png")), true, false);
	TArray<FString> Profiles;
	IFileManager::Get().FindFiles(Profiles, *FPaths::Combine(ProfilingDir, TEXT("*.*")), true, false);

	FString Text = FString::Printf(TEXT("Artifacts\n\nScreenshots (%s):\n"), *ScreenshotDir);
	if (Screenshots.Num() == 0)
	{
		Text += TEXT("  (none)\n");
	}
	for (const FString& File : Screenshots)
	{
		const FString FullPath = FPaths::Combine(ScreenshotDir, File);
		Text += FString::Printf(TEXT("  %s  (%lld bytes)\n"), *File, static_cast<long long>(IFileManager::Get().FileSize(*FullPath)));
	}

	Text += FString::Printf(TEXT("\nProfiling (%s):\n"), *ProfilingDir);
	if (Profiles.Num() == 0)
	{
		Text += TEXT("  (none)\n");
	}
	for (const FString& File : Profiles)
	{
		const FString FullPath = FPaths::Combine(ProfilingDir, File);
		Text += FString::Printf(TEXT("  %s  (%lld bytes)\n"), *File, static_cast<long long>(IFileManager::Get().FileSize(*FullPath)));
	}

	ResultText = Text;
	if (ResultEditor.IsValid())
	{
		ResultEditor->SetText(FText::FromString(ResultText));
	}
	FPlatformProcess::ExploreFolder(*ScreenshotDir);
	SetCallStatus(EUEVCallStatus::Success, TEXT("Listed artifacts and opened the screenshots folder."));
	return FReply::Handled();
}

bool SUEVControlPanel::CanRun() const
{
	const FUEVControlAction* Action = GetSelectedAction();
	return bConnected && !bRequestInFlight && Action && Action->bAllowed;
}

bool SUEVControlPanel::CanStartSupervisor() const
{
	return !Health.SupervisorStatus.Equals(TEXT("connected"), ESearchCase::IgnoreCase);
}

bool SUEVControlPanel::CanVerify() const
{
	if (!Client.IsValid())
	{
		return false;
	}

	const FString ScriptPath = FPaths::Combine(
		FPaths::GetPath(Client->GetDescriptorPath()),
		TEXT("installer"),
		TEXT("install.ps1"));
	return IFileManager::Get().FileExists(*ScriptPath);
}

bool SUEVControlPanel::CanToggleControl() const
{
	if (bControlStartRequested)
	{
		return false;
	}

	const FUEVControlPanelModule* Module = FModuleManager::GetModulePtr<FUEVControlPanelModule>(TEXT("UEVControlPanel"));
	if (Module && Module->IsControlServerOwned())
	{
		return true;
	}
	return !bConnected;
}

FText SUEVControlPanel::GetControlButtonLabel() const
{
	if (bControlStartRequested)
	{
		return FText::FromString(TEXT("Starting..."));
	}

	const FUEVControlPanelModule* Module = FModuleManager::GetModulePtr<FUEVControlPanelModule>(TEXT("UEVControlPanel"));
	if (Module && Module->IsControlServerOwned())
	{
		return FText::FromString(TEXT("Stop UEV"));
	}
	return FText::FromString(bConnected ? TEXT("UEV Online") : TEXT("Start UEV"));
}

bool SUEVControlPanel::CanUndo() const
{
	const FUEVControlHistoryEntry* Entry = GetSelectedHistoryEntry();
	return Entry && !Entry->bUndone && Entry->Undo != TEXT("none");
}

bool SUEVControlPanel::CanRedo() const
{
	const FUEVControlHistoryEntry* Entry = GetSelectedHistoryEntry();
	return Entry && Entry->bUndone && Entry->Undo != TEXT("none");
}

const FUEVControlAction* SUEVControlPanel::GetSelectedAction() const
{
	if (!Tools.IsValidIndex(SelectedToolIndex))
	{
		return nullptr;
	}

	const FUEVControlTool& Tool = Tools[SelectedToolIndex];
	if (bSelectedDirect)
	{
		return Tool.bHasDirect ? &Tool.Direct : nullptr;
	}

	return Tool.Actions.IsValidIndex(SelectedActionIndex) ? &Tool.Actions[SelectedActionIndex] : nullptr;
}

const FUEVControlHistoryEntry* SUEVControlPanel::GetSelectedHistoryEntry() const
{
	for (const TSharedPtr<FUEVHistoryRow>& Row : HistoryRows)
	{
		if (Row.IsValid() && Row->Entry.Id == SelectedHistoryId)
		{
			return &Row->Entry;
		}
	}

	return nullptr;
}

FString SUEVControlPanel::GetSelectionKey() const
{
	if (!Tools.IsValidIndex(SelectedToolIndex))
	{
		return FString();
	}

	FString Key = Tools[SelectedToolIndex].Name;
	const FUEVControlAction* Action = GetSelectedAction();
	if (Action && !bSelectedDirect)
	{
		Key += TEXT(".");
		Key += Action->Name;
	}
	return Key;
}

FString SUEVControlPanel::SingleLine(const FString& Text, const int32 MaxLength)
{
	FString Result = Text.Replace(TEXT("\r"), TEXT(" ")).Replace(TEXT("\n"), TEXT(" "));
	if (Result.Len() > MaxLength)
	{
		Result = Result.Left(MaxLength) + TEXT("...");
	}
	return Result;
}

FSlateColor SUEVControlPanel::GetModeColor(const FString& Mode)
{
	if (Mode == TEXT("read"))
	{
		return FSlateColor(FLinearColor(0.4f, 0.85f, 0.4f));
	}
	if (Mode == TEXT("write") || Mode == TEXT("supervised"))
	{
		return FSlateColor(FLinearColor(1.0f, 0.75f, 0.2f));
	}
	if (Mode == TEXT("blocked"))
	{
		return FSlateColor(FLinearColor(0.95f, 0.35f, 0.35f));
	}
	return FSlateColor(FLinearColor::White);
}

FText SUEVControlPanel::GetCallStatusLabel() const
{
	switch (CallStatus)
	{
	case EUEVCallStatus::Running:
		return FText::FromString(TEXT("RUNNING"));
	case EUEVCallStatus::Success:
		return FText::FromString(TEXT("SUCCESS"));
	case EUEVCallStatus::Warning:
		return FText::FromString(TEXT("WARNING"));
	case EUEVCallStatus::Failure:
		return FText::FromString(TEXT("FAILED"));
	case EUEVCallStatus::Abandoned:
		return FText::FromString(TEXT("ABANDONED"));
	default:
		return FText::FromString(TEXT("IDLE"));
	}
}

FSlateColor SUEVControlPanel::GetStatusColor() const
{
	switch (CallStatus)
	{
	case EUEVCallStatus::Success:
		return FSlateColor(FLinearColor(0.25f, 0.85f, 0.35f));
	case EUEVCallStatus::Running:
	case EUEVCallStatus::Warning:
		return FSlateColor(FLinearColor(1.0f, 0.72f, 0.2f));
	case EUEVCallStatus::Abandoned:
		return FSlateColor(FLinearColor(1.0f, 0.60f, 0.25f));
	case EUEVCallStatus::Failure:
		return FSlateColor(FLinearColor(0.95f, 0.25f, 0.25f));
	default:
		return FSlateColor(FLinearColor(0.8f, 0.8f, 0.8f));
	}
}

FSlateColor SUEVControlPanel::GetResultBorderColor() const
{
	return GetStatusColor();
}

FSlateColor SUEVControlPanel::GetResultTextColor() const
{
	switch (CallStatus)
	{
	case EUEVCallStatus::Success:
		return FSlateColor(FLinearColor(0.65f, 1.0f, 0.65f));
	case EUEVCallStatus::Running:
	case EUEVCallStatus::Warning:
		return FSlateColor(FLinearColor(1.0f, 0.85f, 0.5f));
	case EUEVCallStatus::Abandoned:
		return FSlateColor(FLinearColor(1.0f, 0.72f, 0.45f));
	case EUEVCallStatus::Failure:
		return FSlateColor(FLinearColor(1.0f, 0.55f, 0.55f));
	default:
		return FSlateColor(FLinearColor(0.8f, 0.8f, 0.8f));
	}
}

FSlateColor SUEVControlPanel::GetHistoryStatusColor(const FString& Status) const
{
	const FString Lower = Status.ToLower();
	if (Lower == TEXT("success") || Lower == TEXT("succeeded") || Lower == TEXT("ok"))
	{
		return FSlateColor(FLinearColor(0.25f, 0.85f, 0.35f));
	}
	if (Lower == TEXT("error") || Lower == TEXT("failed") || Lower == TEXT("blocked") || Lower == TEXT("timeout"))
	{
		return FSlateColor(FLinearColor(0.95f, 0.25f, 0.25f));
	}
	if (Lower == TEXT("pending") || Lower == TEXT("running") || Lower == TEXT("abandoned"))
	{
		return FSlateColor(FLinearColor(1.0f, 0.72f, 0.2f));
	}
	return FSlateColor(FLinearColor(0.8f, 0.8f, 0.8f));
}

FSlateColor SUEVControlPanel::GetPieColor() const
{
	if (!bPieKnown)
	{
		return FSlateColor(FLinearColor(0.6f, 0.6f, 0.6f));
	}
	return bPieRunning ? FSlateColor(FLinearColor(1.0f, 0.72f, 0.2f))
					   : FSlateColor(FLinearColor(0.25f, 0.85f, 0.35f));
}

FSlateColor SUEVControlPanel::GetSelectionColor() const
{
	const FUEVControlAction* Action = GetSelectedAction();
	if (!Action)
	{
		return FSlateColor(FLinearColor(0.6f, 0.6f, 0.6f));
	}
	if (!Action->bAllowed)
	{
		return FSlateColor(FLinearColor(0.95f, 0.35f, 0.35f));
	}
	if (Action->Mode == TEXT("read"))
	{
		return FSlateColor(FLinearColor(0.4f, 0.85f, 0.4f));
	}
	if (Action->Mode == TEXT("write") || Action->Mode == TEXT("supervised"))
	{
		return FSlateColor(FLinearColor(1.0f, 0.75f, 0.2f));
	}
	return FSlateColor(FLinearColor(0.8f, 0.8f, 0.8f));
}

FSlateColor SUEVControlPanel::GetRunButtonColor() const
{
	const FUEVControlAction* Action = GetSelectedAction();
	if (!Action || !Action->bAllowed)
	{
		return FSlateColor(FLinearColor(0.25f, 0.25f, 0.25f));
	}
	if (Action->Mode == TEXT("read"))
	{
		return FSlateColor(FLinearColor(0.15f, 0.45f, 0.2f));
	}
	return FSlateColor(FLinearColor(0.55f, 0.38f, 0.1f));
}

void SUEVControlPanel::SetCallStatus(const EUEVCallStatus NewStatus, const FString& Message)
{
	CallStatus = NewStatus;
	StatusMessage = Message;
	UpdateStatusText();
}

TSharedRef<SWidget> SUEVControlPanel::BuildRunRow()
{
	return SNew(SHorizontalBox)
		+ SHorizontalBox::Slot()
		.AutoWidth()
		.VAlign(VAlign_Center)
		.Padding(0.0f, 0.0f, 6.0f, 0.0f)
		[
			SAssignNew(DryRunCheckBox, SCheckBox)
			.IsChecked(this, &SUEVControlPanel::GetDryRunCheckState)
			.IsEnabled(this, &SUEVControlPanel::CanToggleDryRun)
			.OnCheckStateChanged(this, &SUEVControlPanel::OnDryRunStateChanged)
			.ToolTipText(this, &SUEVControlPanel::GetDryRunTooltip)
			[
				SNew(STextBlock)
				.Text(FText::FromString(TEXT("Dry run")))
				.Font(FCoreStyle::GetDefaultFontStyle("Regular", 8))
			]
		]
		+ SHorizontalBox::Slot()
		.AutoWidth()
		.Padding(0.0f, 0.0f, 6.0f, 0.0f)
		[
			SNew(SButton)
			.Text(FText::FromString(TEXT("Stop waiting")))
			.ToolTipText(FText::FromString(TEXT("Stop waiting for the editor response. The editor call is not interrupted and its result may still apply.")))
			.OnClicked(this, &SUEVControlPanel::OnCancelClicked)
			.IsEnabled(this, &SUEVControlPanel::CanCancel)
		]
		+ SHorizontalBox::Slot()
		.FillWidth(1.0f)
		.VAlign(VAlign_Center)
		[
			SNew(STextBlock)
			.Text(this, &SUEVControlPanel::GetRunHintText)
			.Font(FCoreStyle::GetDefaultFontStyle("Regular", 8))
			.ColorAndOpacity(FSlateColor(FLinearColor(0.55f, 0.55f, 0.55f)))
		];
}

TSharedRef<SWidget> SUEVControlPanel::BuildFooter()
{
	return SNew(SHorizontalBox)
		+ SHorizontalBox::Slot()
		.FillWidth(1.0f)
		.VAlign(VAlign_Center)
		[
			SAssignNew(FooterText, STextBlock)
			.Text_Lambda([this]()
			{
				return FText::FromString(GetFooterText());
			})
			.Font(FCoreStyle::GetDefaultFontStyle("Regular", 8))
			.ColorAndOpacity(FSlateColor(FLinearColor(0.55f, 0.55f, 0.55f)))
		];
}

TSharedRef<SWidget> SUEVControlPanel::BuildCompatibilityBanner()
{
	return SNew(SBox)
		.Visibility_Lambda([this]()
		{
			return GetBannerVisibility();
		})
		[
			SNew(SBorder)
			.BorderImage(FCoreStyle::Get().GetBrush("ToolPanel.GroupBorder"))
			.BorderBackgroundColor(FSlateColor(FLinearColor(0.32f, 0.10f, 0.08f)))
			.Padding(6.0f)
			[
				SNew(SHorizontalBox)
				+ SHorizontalBox::Slot()
				.FillWidth(1.0f)
				.VAlign(VAlign_Center)
				[
					SAssignNew(BannerText, STextBlock)
					.AutoWrapText(true)
					.Text_Lambda([this]()
					{
						return GetBannerText();
					})
					.ColorAndOpacity_Lambda([this]()
					{
						return GetBannerColor();
					})
				]
				+ SHorizontalBox::Slot()
				.AutoWidth()
				.VAlign(VAlign_Center)
				.Padding(6.0f, 0.0f, 0.0f, 0.0f)
				[
					SNew(SButton)
					.Text(FText::FromString(TEXT("Retry")))
					.ToolTipText(FText::FromString(TEXT("Reload health and the tool catalog.")))
					.OnClicked(this, &SUEVControlPanel::OnRefreshClicked)
				]
			]
		];
}

TSharedRef<SWidget> SUEVControlPanel::BuildHistoryFilterCombo(
	TArray<TSharedPtr<FString>>& Options,
	TSharedPtr<FString>& Selection,
	TSharedPtr<SComboBox<TSharedPtr<FString>>>& Combo,
	const FString& Label,
	const FString& Tooltip,
	TFunction<void(const FString&)> OnChanged)
{
	if (!Selection.IsValid() || !Options.Contains(Selection))
	{
		Selection = Options.Num() > 0 ? Options[0] : MakeShared<FString>(TEXT("All"));
	}

	// SComboBox renders a "No Content Provided" warning unless a Content widget is supplied.
	const TSharedPtr<FString>* SelectionPtr = &Selection;
	return SNew(SHorizontalBox)
		+ SHorizontalBox::Slot()
		.AutoWidth()
		.VAlign(VAlign_Center)
		.Padding(0.0f, 0.0f, 2.0f, 0.0f)
		[
			SNew(STextBlock)
			.Text(FText::FromString(Label))
			.ToolTipText(FText::FromString(Tooltip))
			.Font(FCoreStyle::GetDefaultFontStyle("Regular", 8))
		]
		+ SHorizontalBox::Slot()
		.AutoWidth()
		.VAlign(VAlign_Center)
		[
			SAssignNew(Combo, SComboBox<TSharedPtr<FString>>)
			.OptionsSource(&Options)
			.InitiallySelectedItem(Selection)
			.ToolTipText(FText::FromString(Tooltip))
			.Content()
			[
				SNew(STextBlock)
				.Text_Lambda([SelectionPtr]()
				{
					const TSharedPtr<FString>& Current = *SelectionPtr;
					return FText::FromString(Current.IsValid() ? *Current : FString(TEXT("All")));
				})
				.Font(FCoreStyle::GetDefaultFontStyle("Regular", 8))
			]
			.OnGenerateWidget_Lambda([](TSharedPtr<FString> Item)
			{
				return SNew(STextBlock)
					.Text(FText::FromString(Item.IsValid() ? *Item : FString()))
					.Font(FCoreStyle::GetDefaultFontStyle("Regular", 8));
			})
			.OnSelectionChanged_Lambda([this, &Selection, OnChanged](TSharedPtr<FString> Item, ESelectInfo::Type)
			{
				if (!Item.IsValid())
				{
					return;
				}
				Selection = Item;
				if (bSyncingHistoryFilters)
				{
					return;
				}
				OnChanged(*Item);
			})
		];
}

void SUEVControlPanel::RefreshHistoryFilterOptions()
{
	TArray<FString> ToolNames;
	TArray<FString> ActionLabels;
	for (const TSharedPtr<FUEVHistoryRow>& Row : AllHistoryRows)
	{
		if (!Row.IsValid())
		{
			continue;
		}
		ToolNames.AddUnique(Row->Entry.Tool);
		if (HistoryFilterTool.IsEmpty() || HistoryFilterTool == TEXT("All") || Row->Entry.Tool == HistoryFilterTool)
		{
			const FString ActionLabel = Row->Entry.Action.IsEmpty()
				? Row->Entry.Tool
				: FString::Printf(TEXT("%s.%s"), *Row->Entry.Tool, *Row->Entry.Action);
			ActionLabels.AddUnique(ActionLabel);
		}
	}
	ToolNames.Sort();
	ToolNames.Insert(TEXT("All"), 0);
	ActionLabels.Sort();
	ActionLabels.Insert(TEXT("All"), 0);

	HistoryToolOptions.Reset();
	for (const FString& Value : ToolNames)
	{
		HistoryToolOptions.Add(MakeShared<FString>(Value));
	}
	HistoryActionOptions.Reset();
	for (const FString& Value : ActionLabels)
	{
		HistoryActionOptions.Add(MakeShared<FString>(Value));
	}
	if (HistoryStatusOptions.Num() == 0)
	{
		const TArray<FString> StatusValues = { TEXT("All"), TEXT("OK"), TEXT("Failed") };
		for (const FString& Value : StatusValues)
		{
			HistoryStatusOptions.Add(MakeShared<FString>(Value));
		}
	}

	if (HistoryFilterTool.IsEmpty() || !ToolNames.Contains(HistoryFilterTool))
	{
		HistoryFilterTool = TEXT("All");
	}
	if (HistoryFilterAction.IsEmpty() || !ActionLabels.Contains(HistoryFilterAction))
	{
		HistoryFilterAction = TEXT("All");
	}
	if (HistoryFilterStatus.IsEmpty() || !FindOption(HistoryStatusOptions, HistoryFilterStatus).IsValid())
	{
		HistoryFilterStatus = TEXT("All");
	}

	HistoryToolSelection = FindOption(HistoryToolOptions, HistoryFilterTool);
	HistoryActionSelection = FindOption(HistoryActionOptions, HistoryFilterAction);
	HistoryStatusSelection = FindOption(HistoryStatusOptions, HistoryFilterStatus);

	const auto SyncCombo = [](const TSharedPtr<SComboBox<TSharedPtr<FString>>>& InCombo, const TSharedPtr<FString>& InSelection)
	{
		if (InCombo.IsValid())
		{
			InCombo->RefreshOptions();
			if (InSelection.IsValid())
			{
				InCombo->SetSelectedItem(InSelection);
			}
		}
	};
	bSyncingHistoryFilters = true;
	SyncCombo(HistoryToolCombo, HistoryToolSelection);
	SyncCombo(HistoryActionCombo, HistoryActionSelection);
	SyncCombo(HistoryStatusCombo, HistoryStatusSelection);
	bSyncingHistoryFilters = false;
}

void SUEVControlPanel::ApplyHistoryFilters()
{
	HistoryRows.Reset();
	for (const TSharedPtr<FUEVHistoryRow>& Row : AllHistoryRows)
	{
		if (!Row.IsValid())
		{
			continue;
		}
		const FString ActionLabel = Row->Entry.Action.IsEmpty()
			? Row->Entry.Tool
			: FString::Printf(TEXT("%s.%s"), *Row->Entry.Tool, *Row->Entry.Action);
		if (!HistoryFilterTool.IsEmpty() && HistoryFilterTool != TEXT("All") && Row->Entry.Tool != HistoryFilterTool)
		{
			continue;
		}
		if (!HistoryFilterAction.IsEmpty() && HistoryFilterAction != TEXT("All") && ActionLabel != HistoryFilterAction)
		{
			continue;
		}
		const FString Status = Row->Entry.Status.ToLower();
		if (HistoryFilterStatus == TEXT("OK"))
		{
			const bool bOkStatus = Status.IsEmpty()
				|| Status == TEXT("success")
				|| Status == TEXT("succeeded")
				|| Status == TEXT("ok");
			if (!bOkStatus)
			{
				continue;
			}
		}
		else if (HistoryFilterStatus == TEXT("Failed"))
		{
			const bool bFailedStatus =
				Status == TEXT("error")
				|| Status == TEXT("failed")
				|| Status == TEXT("blocked")
				|| Status == TEXT("timeout")
				|| Status == TEXT("abandoned")
				|| Status == TEXT("denied");
			if (!bFailedStatus)
			{
				continue;
			}
		}
		HistoryRows.Add(Row);
	}

	if (HistoryListView.IsValid())
	{
		HistoryListView->RequestListRefresh();
		for (const TSharedPtr<FUEVHistoryRow>& Row : HistoryRows)
		{
			if (Row.IsValid() && Row->Entry.Id == SelectedHistoryId)
			{
				HistoryListView->SetSelection(Row);
				break;
			}
		}
	}
}

ECheckBoxState SUEVControlPanel::GetDryRunCheckState() const
{
	return bDryRunRequested ? ECheckBoxState::Checked : ECheckBoxState::Unchecked;
}

bool SUEVControlPanel::CanToggleDryRun() const
{
	const FUEVControlAction* Action = GetSelectedAction();
	if (!Action || !Action->bSupportsDryRun || !bConnected || bRequestInFlight)
	{
		return false;
	}
	return !UnsupportedReasons.Contains(GetSelectionKey());
}

FText SUEVControlPanel::GetDryRunTooltip() const
{
	const FUEVControlAction* Action = GetSelectedAction();
	if (!Action)
	{
		return FText::FromString(TEXT("Select an action to see whether it supports dry runs."));
	}
	const FString Key = GetSelectionKey();
	if (!Action->bSupportsDryRun)
	{
		return FText::FromString(FString::Printf(TEXT("%s does not declare dry-run support."), *Key));
	}
	if (const FString* Reason = UnsupportedReasons.Find(Key))
	{
		return FText::FromString(FString::Printf(TEXT("The server rejected dry-run for this action: %s"), **Reason));
	}
	return FText::FromString(TEXT("Send dry_run=true and report what the action would do instead of applying it."));
}

FText SUEVControlPanel::GetRunHintText() const
{
	const FUEVControlAction* Action = GetSelectedAction();
	if (!Action)
	{
		return FText::FromString(TEXT("Select an action. Dry run is only offered for actions that declare it."));
	}
	if (!bConnected)
	{
		return FText::FromString(TEXT("Control server offline: start the stack, then press Refresh."));
	}
	const FString Key = GetSelectionKey();
	if (!Action->bSupportsDryRun)
	{
		return FText::FromString(FString::Printf(
			TEXT("%s does not declare dry-run support, so Dry run stays disabled and dry_run is never sent."),
			*Key));
	}
	if (const FString* Reason = UnsupportedReasons.Find(Key))
	{
		return FText::FromString(FString::Printf(TEXT("The server rejected dry-run for this action: %s"), **Reason));
	}
	if (bDryRunRequested)
	{
		return FText::FromString(TEXT("Dry run armed: nothing will be applied by the panel."));
	}
	return FText::FromString(TEXT("Stop waiting leaves the editor call running; a result may still apply. Dry run is offered only for actions that declare it."));
}

void SUEVControlPanel::OnDryRunStateChanged(const ECheckBoxState NewState)
{
	const FUEVControlAction* Action = GetSelectedAction();
	const bool bWant = NewState == ECheckBoxState::Checked;
	const FString Key = GetSelectionKey();
	if (bWant && (!Action || !Action->bSupportsDryRun))
	{
		bDryRunRequested = false;
		SetCallStatus(
			EUEVCallStatus::Warning,
			FString::Printf(TEXT("dry_run_unsupported: %s does not declare dry-run support."), *Key));
		return;
	}
	if (bWant && UnsupportedReasons.Contains(Key))
	{
		bDryRunRequested = false;
		SetCallStatus(EUEVCallStatus::Warning, FString::Printf(TEXT("dry_run_unsupported: %s"), *UnsupportedReasons[Key]));
		return;
	}
	bDryRunRequested = bWant;
	SetCallStatus(
		EUEVCallStatus::Idle,
		bWant ? TEXT("Dry run armed: nothing will be applied by the panel.") : TEXT("Dry run disabled."));
}

bool SUEVControlPanel::CanCancel() const
{
	return bRequestInFlight && Client.IsValid();
}

FReply SUEVControlPanel::OnCancelClicked()
{
	if (!bRequestInFlight || !Client.IsValid())
	{
		SetCallStatus(EUEVCallStatus::Warning, TEXT("No call is in flight."));
		return FReply::Handled();
	}

	const FString ToolName = PendingToolName;
	const FString ActionName = PendingActionName;
	const TWeakPtr<SUEVControlPanel> WeakPanel = StaticCastSharedRef<SUEVControlPanel>(SharedThis(this));
	SetCallStatus(EUEVCallStatus::Running, TEXT("Stopping the wait for the editor..."));

	Client->GetActiveCalls([WeakPanel, ToolName, ActionName](const TArray<FUEVControlCallInfo>& Calls, const bool bOk)
	{
		if (const TSharedPtr<SUEVControlPanel> This = WeakPanel.Pin())
		{
			if (!bOk)
			{
				This->SetCallStatus(EUEVCallStatus::Warning, TEXT("Could not list active calls."));
				return;
			}
			if (!This->Client.IsValid())
			{
				return;
			}

			FString CallId;
			for (const FUEVControlCallInfo& Call : Calls)
			{
				if (!ToolName.IsEmpty() && Call.Tool != ToolName)
				{
					continue;
				}
				if (!ActionName.IsEmpty() && !Call.Action.IsEmpty() && Call.Action != ActionName)
				{
					continue;
				}
				CallId = Call.Id;
				break;
			}
			if (CallId.IsEmpty() && Calls.Num() == 1)
			{
				CallId = Calls[0].Id;
			}
			if (CallId.IsEmpty())
			{
				This->SetCallStatus(EUEVCallStatus::Warning, TEXT("No active call found to stop."));
				return;
			}

			This->PendingCallId = CallId;
			This->Client->CancelCall(CallId, [WeakPanel](const bool bCancelOk, const FString& CancelNote, const FString& CancelError)
			{
				if (const TSharedPtr<SUEVControlPanel> Panel = WeakPanel.Pin())
				{
					// The in-flight call may have resolved first (the server answers an abandoned call immediately);
					// in that case the panel already shows the outcome and must not overwrite it.
					if (!Panel->bRequestInFlight)
					{
						return;
					}
					if (bCancelOk)
					{
						Panel->SetCallStatus(
							EUEVCallStatus::Abandoned,
							CancelNote.IsEmpty()
								? FString(TEXT("Abandoned by client (applied=false). The editor action may still be running."))
								: CancelNote);
					}
					else
					{
						Panel->SetCallStatus(
							EUEVCallStatus::Warning,
							CancelError.IsEmpty() ? FString(TEXT("Cancel request failed.")) : CancelError);
					}
				}
			});
		}
	});

	return FReply::Handled();
}

FReply SUEVControlPanel::OnExportHistoryClicked()
{
	const TSharedPtr<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetStringField(TEXT("exportedAt"), FDateTime::Now().ToString(TEXT("%Y-%m-%dT%H:%M:%SZ")));
	Root->SetStringField(TEXT("filterTool"), HistoryFilterTool.IsEmpty() ? FString(TEXT("All")) : HistoryFilterTool);
	Root->SetStringField(TEXT("filterAction"), HistoryFilterAction.IsEmpty() ? FString(TEXT("All")) : HistoryFilterAction);
	Root->SetStringField(TEXT("filterStatus"), HistoryFilterStatus.IsEmpty() ? FString(TEXT("All")) : HistoryFilterStatus);
	Root->SetNumberField(TEXT("entryCount"), HistoryRows.Num());

	TArray<TSharedPtr<FJsonValue>> Entries;
	for (const TSharedPtr<FUEVHistoryRow>& Row : HistoryRows)
	{
		if (!Row.IsValid())
		{
			continue;
		}
		const TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
		Entry->SetStringField(TEXT("id"), Row->Entry.Id);
		Entry->SetStringField(TEXT("timestamp"), Row->Entry.Timestamp);
		Entry->SetStringField(TEXT("tool"), Row->Entry.Tool);
		Entry->SetStringField(TEXT("action"), Row->Entry.Action);
		Entry->SetStringField(TEXT("mode"), Row->Entry.Mode);
		Entry->SetStringField(TEXT("status"), Row->Entry.Status);
		Entry->SetBoolField(TEXT("undone"), Row->Entry.bUndone);
		Entry->SetNumberField(TEXT("durationMs"), Row->Entry.DurationMs);
		Entry->SetStringField(TEXT("resultSummary"), Row->Entry.ResultSummary);
		Entry->SetStringField(TEXT("argsPreview"), Row->Entry.ArgsPreview);
		Entries.Add(MakeShared<FJsonValueObject>(Entry));
	}
	Root->SetArrayField(TEXT("entries"), Entries);

	FString Text;
	const TSharedRef<TJsonWriter<TCHAR, TPrettyJsonPrintPolicy<TCHAR>>> Writer =
		TJsonWriterFactory<TCHAR, TPrettyJsonPrintPolicy<TCHAR>>::Create(&Text);
	if (!FJsonSerializer::Serialize(Root.ToSharedRef(), Writer))
	{
		SetCallStatus(EUEVCallStatus::Failure, TEXT("Could not serialize the history export."));
		return FReply::Handled();
	}

	const FString Dir = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UEV"), TEXT("History"));
	IFileManager::Get().MakeDirectory(*Dir, true);
	const FString FilePath = FPaths::Combine(
		Dir,
		FString::Printf(TEXT("history-%s.json"), *FDateTime::Now().ToString(TEXT("%Y%m%d-%H%M%S"))));
	if (!FFileHelper::SaveStringToFile(Text, *FilePath))
	{
		SetCallStatus(EUEVCallStatus::Failure, FString::Printf(TEXT("Failed to write %s"), *FilePath));
		return FReply::Handled();
	}

	// The saved dir is relative to the project, so show the resolved path the user can actually open.
	const FString DisplayPath = FPaths::ConvertRelativePathToFull(FilePath);
	ResultText = FString::Printf(
		TEXT("Exported %d history entries to:\n%s"),
		HistoryRows.Num(),
		*DisplayPath);
	if (ResultEditor.IsValid())
	{
		ResultEditor->SetText(FText::FromString(ResultText));
	}
	SetCallStatus(
		EUEVCallStatus::Success,
		FString::Printf(TEXT("Exported %d filtered history entries."), HistoryRows.Num()));
	return FReply::Handled();
}

FString SUEVControlPanel::FormatDryRunResult(const FString& RawText) const
{
	const FString Header = TEXT("DRY RUN - nothing was applied by this panel.");
	TSharedPtr<FJsonObject> Json;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(RawText);
	if (!FJsonSerializer::Deserialize(Reader, Json) || !Json.IsValid())
	{
		return Header + TEXT("\n\n") + RawText;
	}

	FString WouldDo = FormatJsonField(Json, TEXT("wouldDo"));
	if (WouldDo.IsEmpty())
	{
		WouldDo = FormatJsonField(Json, TEXT("planned"));
	}
	FString Affected = FormatJsonField(Json, TEXT("affected"));
	if (Affected.IsEmpty())
	{
		Affected = FormatJsonField(Json, TEXT("affects"));
	}
	if (Affected.IsEmpty())
	{
		Affected = FormatJsonField(Json, TEXT("target"));
	}
	const FString Warnings = FormatJsonField(Json, TEXT("warnings"));

	FString Text = Header;
	if (!WouldDo.IsEmpty())
	{
		Text += FString::Printf(TEXT("\nwouldDo: %s"), *WouldDo);
	}
	if (!Affected.IsEmpty())
	{
		Text += FString::Printf(TEXT("\naffected: %s"), *Affected);
	}
	if (!Warnings.IsEmpty())
	{
		Text += FString::Printf(TEXT("\nwarnings: %s"), *Warnings);
	}
	Text += TEXT("\n\n---- raw ----\n");
	Text += RawText;
	return Text;
}

FString SUEVControlPanel::FormatAbandonedResult(const FUEVControlCallResult& Result) const
{
	FString Text = Result.Note.IsEmpty() ? FString(TEXT("Abandoned by client.")) : Result.Note;
	Text += TEXT("\napplied=false");
	Text += TEXT("\nThe editor call may still be running; no editor execution was interrupted.");
	return Text;
}

void SUEVControlPanel::UpdateCompatibilityState()
{
	TArray<FString> Problems;

	if (!CatalogInfo.bLoaded)
	{
		Problems.Add(CatalogInfo.Error.IsEmpty()
			? FString(TEXT("Catalog load failed; the panel cannot verify the server version."))
			: FString::Printf(TEXT("Catalog load failed: %s"), *CatalogInfo.Error));
	}
	else
	{
		if (CatalogInfo.ProtocolVersion != UEVExpectedProtocolVersion)
		{
			Problems.Add(FString::Printf(
				TEXT("Protocol mismatch: server %d, panel expects %d. Update the panel or the server."),
				CatalogInfo.ProtocolVersion,
				UEVExpectedProtocolVersion));
		}
		if (!CatalogInfo.ProductVersion.IsEmpty() && CatalogInfo.ProductVersion != UEVExpectedProductVersion)
		{
			Problems.Add(FString::Printf(
				TEXT("Product version mismatch: server %s, panel expects %s."),
				*CatalogInfo.ProductVersion,
				UEVExpectedProductVersion));
		}
	}

	if (Health.bEngineReported && !Health.bEngineCompatible)
	{
		Problems.Add(Health.EngineReason.IsEmpty()
			? FString::Printf(
				TEXT("Engine %s is outside the supported range 4.27.0 to 4.27.x."),
				Health.EngineVersion.IsEmpty() ? TEXT("?") : *Health.EngineVersion)
			: Health.EngineReason);
	}

	CompatibilityBanner = FString::Join(Problems, TEXT("\n"));
}

EVisibility SUEVControlPanel::GetBannerVisibility() const
{
	return CompatibilityBanner.IsEmpty() ? EVisibility::Collapsed : EVisibility::Visible;
}

FText SUEVControlPanel::GetBannerText() const
{
	return FText::FromString(CompatibilityBanner);
}

FSlateColor SUEVControlPanel::GetBannerColor() const
{
	return FSlateColor(FLinearColor(1.0f, 0.78f, 0.55f));
}

FString SUEVControlPanel::GetFooterText() const
{
	// Match /api/catalog: direct tools are tools, not actions (their action list is empty).
	int32 ActionCount = 0;
	for (const FUEVControlTool& Tool : Tools)
	{
		ActionCount += Tool.Actions.Num();
	}

	FString Text = FString::Printf(
		TEXT("UEV %s | server %s | protocol %d (expected %d) | %d tools / %d actions | catalog %s"),
		CatalogInfo.ProductVersion.IsEmpty() ? TEXT("?") : *CatalogInfo.ProductVersion,
		CatalogInfo.ServerVersion.IsEmpty() ? TEXT("?") : *CatalogInfo.ServerVersion,
		CatalogInfo.ProtocolVersion,
		UEVExpectedProtocolVersion,
		Tools.Num(),
		ActionCount,
		CatalogInfo.bLoaded ? TEXT("loaded") : TEXT("failed"));

	if (Health.bEngineReported)
	{
		// /api/health reports engineIdentity.compatible/reason but no concrete version today.
		if (Health.EngineVersion.IsEmpty())
		{
			Text += Health.bEngineCompatible ? TEXT(" | engine compatible") : TEXT(" | engine mismatch");
		}
		else
		{
			Text += FString::Printf(
				TEXT(" | engine %s (%s)"),
				*Health.EngineVersion,
				Health.bEngineCompatible ? TEXT("ok") : TEXT("mismatch"));
		}
	}
	return Text;
}

void SUEVControlPanel::OpenAssetPicker(const FString& ParamName)
{
	AssetPickerParamName = ParamName;
	AssetPickerRows.Reset();
	AssetPickerLabels.Reset();
	AssetPickerSelection.Reset();
	bAssetPickerInFlight = false;

	TSharedRef<SWindow> Window = SNew(SWindow)
		.Title(FText::FromString(FString::Printf(TEXT("Pick asset for %s"), *ParamName)))
		.ClientSize(FVector2D(640.0f, 460.0f))
		.SizingRule(ESizingRule::UserSized)
		.AutoCenter(EAutoCenter::PreferredWorkArea);

	const TWeakPtr<SUEVControlPanel> WeakPanel = StaticCastSharedRef<SUEVControlPanel>(SharedThis(this));
	Window->SetContent(
		SNew(SVerticalBox)
		+ SVerticalBox::Slot()
		.AutoHeight()
		.Padding(6.0f)
		[
			SNew(SHorizontalBox)
			+ SHorizontalBox::Slot()
			.FillWidth(1.0f)
			[
				SAssignNew(AssetPickerSearchBox, SSearchBox)
				.HintText(FText::FromString(TEXT("Search assets (empty lists the project)")))
				.OnTextCommitted_Lambda([WeakPanel](const FText& Text, ETextCommit::Type)
				{
					if (const TSharedPtr<SUEVControlPanel> This = WeakPanel.Pin())
					{
						This->RefreshAssetPicker(Text.ToString());
					}
				})
			]
			+ SHorizontalBox::Slot()
			.AutoWidth()
			.Padding(4.0f, 0.0f, 0.0f, 0.0f)
			[
				SNew(SButton)
				.Text(FText::FromString(TEXT("Search")))
				.OnClicked_Lambda([WeakPanel]()
				{
					if (const TSharedPtr<SUEVControlPanel> This = WeakPanel.Pin())
					{
						This->RefreshAssetPicker(This->AssetPickerSearchBox.IsValid()
							? This->AssetPickerSearchBox->GetText().ToString()
							: FString());
					}
					return FReply::Handled();
				})
			]
		]
		+ SVerticalBox::Slot()
		.FillHeight(1.0f)
		.Padding(6.0f, 0.0f, 6.0f, 0.0f)
		[
			SNew(SBorder)
			.BorderImage(FCoreStyle::Get().GetBrush("ToolPanel.GroupBorder"))
			[
				SAssignNew(AssetPickerListView, SListView<TSharedPtr<FString>>)
				.ListItemsSource(&AssetPickerRows)
				.OnGenerateRow_Lambda([WeakPanel](TSharedPtr<FString> Item, const TSharedRef<STableViewBase>& OwnerTable)
				{
					FString Label = Item.IsValid() ? *Item : FString();
					if (const TSharedPtr<SUEVControlPanel> This = WeakPanel.Pin())
					{
						if (const FString* Found = This->AssetPickerLabels.Find(Label))
						{
							Label = *Found;
						}
					}
					return SNew(STableRow<TSharedPtr<FString>>, OwnerTable)
						.Padding(FMargin(4.0f, 2.0f))
						[
							SNew(STextBlock)
							.Text(FText::FromString(Label))
						];
				})
				.OnSelectionChanged_Lambda([WeakPanel](TSharedPtr<FString> Item, ESelectInfo::Type)
				{
					if (const TSharedPtr<SUEVControlPanel> This = WeakPanel.Pin())
					{
						This->AssetPickerSelection = Item;
					}
				})
			]
		]
		+ SVerticalBox::Slot()
		.AutoHeight()
		.Padding(6.0f)
		[
			SNew(SHorizontalBox)
			+ SHorizontalBox::Slot()
			.FillWidth(1.0f)
			.VAlign(VAlign_Center)
			[
				SNew(STextBlock)
				.Text(FText::FromString(TEXT("The chosen asset path is written into the parameter.")))
				.Font(FCoreStyle::GetDefaultFontStyle("Regular", 8))
				.ColorAndOpacity(FSlateColor(FLinearColor(0.6f, 0.6f, 0.6f)))
			]
			+ SHorizontalBox::Slot()
			.AutoWidth()
			.Padding(6.0f, 0.0f, 0.0f, 0.0f)
			[
				SNew(SButton)
				.Text(FText::FromString(TEXT("Use asset")))
				.OnClicked(this, &SUEVControlPanel::OnAssetPickerAcceptClicked)
			]
			+ SHorizontalBox::Slot()
			.AutoWidth()
			.Padding(6.0f, 0.0f, 0.0f, 0.0f)
			[
				SNew(SButton)
				.Text(FText::FromString(TEXT("Cancel")))
				.OnClicked(this, &SUEVControlPanel::OnAssetPickerCancelClicked)
			]
		]);

	AssetPickerWindow = Window;
	FSlateApplication::Get().AddWindow(Window);
	RefreshAssetPicker(FString());
}

void SUEVControlPanel::RefreshAssetPicker(const FString& InSearchText)
{
	if (!Client.IsValid() || bAssetPickerInFlight)
	{
		return;
	}

	TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
	const FString Term = InSearchText.TrimStartAndEnd();
	if (!Term.IsEmpty())
	{
		Params->SetStringField(TEXT("search_term"), Term);
	}
	Params->SetNumberField(TEXT("limit"), 50.0);
	Params->SetBoolField(TEXT("include_engine"), false);

	bAssetPickerInFlight = true;
	const TWeakPtr<SUEVControlPanel> WeakPanel = StaticCastSharedRef<SUEVControlPanel>(SharedThis(this));
	Client->CallTool(TEXT("manage_asset"), TEXT("search"), Params, [WeakPanel](const FUEVControlCallResult& Result)
	{
		if (const TSharedPtr<SUEVControlPanel> This = WeakPanel.Pin())
		{
			This->bAssetPickerInFlight = false;
			This->AssetPickerRows.Reset();
			This->AssetPickerLabels.Reset();

			const FString Text = Result.Text.TrimStartAndEnd();
			if (!Text.IsEmpty())
			{
				TSharedPtr<FJsonObject> Json;
				const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Text);
				const TArray<TSharedPtr<FJsonValue>>* Assets = nullptr;
				if (FJsonSerializer::Deserialize(Reader, Json) && Json.IsValid() && Json->TryGetArrayField(TEXT("assets"), Assets) && Assets)
				{
					for (const TSharedPtr<FJsonValue>& AssetValue : *Assets)
					{
						// manage_asset.search reports "path" as the containing folder and "object_path" as the asset
						// itself, so the folder is never a usable value for an *_path parameter.
						FString FolderPath;
						FString ObjectPath;
						FString PackageName;
						FString AssetName;
						FString ClassName;
						if (AssetValue.IsValid() && AssetValue->Type == EJson::Object)
						{
							const TSharedPtr<FJsonObject> Object = AssetValue->AsObject();
							if (Object.IsValid())
							{
								Object->TryGetStringField(TEXT("path"), FolderPath);
								Object->TryGetStringField(TEXT("object_path"), ObjectPath);
								Object->TryGetStringField(TEXT("package_name"), PackageName);
								Object->TryGetStringField(TEXT("name"), AssetName);
								Object->TryGetStringField(TEXT("class"), ClassName);
							}
						}
						else if (AssetValue.IsValid() && AssetValue->Type == EJson::String)
						{
							ObjectPath = AssetValue->AsString();
						}

						FString Path = ObjectPath;
						if (Path.IsEmpty())
						{
							Path = PackageName;
						}
						if (Path.IsEmpty())
						{
							Path = FolderPath;
						}
						if (Path.IsEmpty())
						{
							continue;
						}

						FString Label;
						if (!AssetName.IsEmpty() && !ClassName.IsEmpty())
						{
							Label = FString::Printf(TEXT("%s  (%s)    %s"), *AssetName, *ClassName, *Path);
						}
						else if (!AssetName.IsEmpty())
						{
							Label = FString::Printf(TEXT("%s    %s"), *AssetName, *Path);
						}
						else
						{
							Label = ClassName.IsEmpty() ? Path : FString::Printf(TEXT("%s  (%s)"), *Path, *ClassName);
						}
						This->AssetPickerRows.Add(MakeShared<FString>(Path));
						This->AssetPickerLabels.Add(Path, Label);
					}
				}
			}

			if (This->AssetPickerListView.IsValid())
			{
				This->AssetPickerListView->RequestListRefresh();
			}
			if (!Result.bOk)
			{
				This->SetCallStatus(
					EUEVCallStatus::Warning,
					Result.Error.IsEmpty() ? FString(TEXT("Asset search failed.")) : Result.Error);
			}
		}
	});
}

void SUEVControlPanel::CloseAssetPicker()
{
	if (AssetPickerWindow.IsValid())
	{
		AssetPickerWindow->RequestDestroyWindow();
	}
	AssetPickerWindow.Reset();
	AssetPickerListView.Reset();
	AssetPickerSearchBox.Reset();
	AssetPickerRows.Reset();
	AssetPickerSelection.Reset();
	bAssetPickerInFlight = false;
}

FReply SUEVControlPanel::OnAssetPickerAcceptClicked()
{
	if (!AssetPickerSelection.IsValid())
	{
		SetCallStatus(EUEVCallStatus::Warning, TEXT("Pick an asset from the list first."));
		return FReply::Handled();
	}

	const FString SelectedPath = *AssetPickerSelection;
	FUEVParamTarget Target;
	Target.Scope = EUEVParamScope::TopLevel;
	Target.ParamName = AssetPickerParamName;
	SetTargetValue(Target, MakeShared<FJsonValueString>(SelectedPath));
	RefreshRawParamEditor(AssetPickerParamName);
	// The generated form builds its editors from the params JSON, so it has to be rebuilt to show the new value.
	bFormRefreshPending = true;
	// Picking an asset edits parameters only; it must not relabel the Result pane, which still
	// belongs to the last editor call (and would otherwise read SUCCESS over an old result body).
	StatusMessage = FString::Printf(TEXT("Set %s to %s"), *AssetPickerParamName, *SelectedPath);
	UpdateStatusText();
	CloseAssetPicker();
	return FReply::Handled();
}

FReply SUEVControlPanel::OnAssetPickerCancelClicked()
{
	CloseAssetPicker();
	return FReply::Handled();
}
