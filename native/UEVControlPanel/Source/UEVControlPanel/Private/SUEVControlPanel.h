#pragma once

#include "CoreMinimal.h"
#include "UEVControlClient.h"
#include "Widgets/DeclarativeSyntaxSupport.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SCheckBox.h"
#include "Widgets/Input/SComboBox.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Input/SMultiLineEditableTextBox.h"
#include "Widgets/Input/SSearchBox.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/SWindow.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Views/SListView.h"

class FJsonValue;
class SVerticalBox;

enum class EUEVCallStatus : uint8
{
	Idle,
	Running,
	Success,
	Warning,
	Failure,
	Abandoned,
};

/** Where a form control writes its value inside the JSON params object. */
enum class EUEVParamScope : uint8
{
	TopLevel,
	Property,
	Element,
};

struct FUEVParamTarget
{
	EUEVParamScope Scope = EUEVParamScope::TopLevel;
	FString ParamName;
	FString PropertyName;
	int32 ArrayIndex = INDEX_NONE;
};

struct FUEVToolRow
{
	int32 ToolIndex = INDEX_NONE;
	int32 ActionIndex = INDEX_NONE;
	bool bDirect = false;
	FString Label;
	FString Mode;
	bool bAllowed = false;
	FString Tooltip;
};

struct FUEVHistoryRow
{
	FUEVControlHistoryEntry Entry;
	FString Label;
};

struct FUEVParamRow
{
	FUEVParamInfo Param;
	TArray<TSharedPtr<FString>> Options;
	TSharedPtr<FString> CurrentOption;
};

class SUEVControlPanel : public SCompoundWidget
{
public:
	SLATE_BEGIN_ARGS(SUEVControlPanel) {}
	SLATE_END_ARGS()

	void Construct(const FArguments& InArgs);
	virtual void Tick(const FGeometry& AllottedGeometry, const double InCurrentTime, const float InDeltaTime) override;

private:
	void RefreshAll();
	void RefreshHealth();
	void RefreshCatalog();
	void RefreshPieStatus();
	void RefreshHistory();

	void RebuildToolRows();
	void RebuildHistoryRows();
	void RebuildParamForm();
	void SetParamValue(const FString& Name, const TSharedPtr<FJsonValue>& Value);
	FString GetParamText(const TSharedPtr<FJsonObject>& Params, const FString& Name) const;
	bool GetParamBool(const TSharedPtr<FJsonObject>& Params, const FString& Name, bool bDefault = false) const;

	bool ParseParams(TSharedPtr<FJsonObject>& OutParams) const;
	void CommitParams(const TSharedPtr<FJsonObject>& Params);
	bool GetTargetValue(const TSharedPtr<FJsonObject>& Params, const FUEVParamTarget& Target, TSharedPtr<FJsonValue>& OutValue) const;
	void SetTargetValue(const FUEVParamTarget& Target, const TSharedPtr<FJsonValue>& Value);
	void RefreshRawParamEditor(const FString& ParamName);
	void RefreshRawParamEditors();
	TSharedRef<SWidget> BuildValueEditor(const FUEVParamInfo& Param, const FUEVParamTarget& Target, bool bCompact);
	void AddParamRow(const TSharedRef<SVerticalBox>& Box, const FUEVParamInfo& Param, const FUEVParamTarget& Target, bool bCompact);
	TSharedPtr<FJsonValue> MakeDefaultValue(const FUEVParamInfo& Param) const;

	void UpdateConnectionText();
	void UpdateStatusText();

	TSharedRef<SWidget> BuildToolbar();
	TSharedRef<SWidget> BuildHistoryBar();
	TSharedRef<SWidget> BuildRunRow();
	TSharedRef<SWidget> BuildFooter();
	TSharedRef<SWidget> BuildCompatibilityBanner();
	TSharedRef<SWidget> BuildHistoryFilterCombo(
		TArray<TSharedPtr<FString>>& Options,
		TSharedPtr<FString>& Selection,
		TSharedPtr<SComboBox<TSharedPtr<FString>>>& Combo,
		const FString& Label,
		const FString& Tooltip,
		TFunction<void(const FString&)> OnChanged);

	TSharedRef<ITableRow> OnGenerateToolRow(TSharedPtr<FUEVToolRow> Item, const TSharedRef<STableViewBase>& OwnerTable);
	void OnToolSelectionChanged(TSharedPtr<FUEVToolRow> Item, ESelectInfo::Type SelectInfo);

	TSharedRef<ITableRow> OnGenerateHistoryRow(TSharedPtr<FUEVHistoryRow> Item, const TSharedRef<STableViewBase>& OwnerTable);
	void OnHistorySelectionChanged(TSharedPtr<FUEVHistoryRow> Item, ESelectInfo::Type SelectInfo);

	void OnSearchChanged(const FText& NewText);
	void OnParamsChanged(const FText& NewText);

	FReply OnRunClicked();
	FReply OnRefreshClicked();
	FReply OnHistoryClicked();
	FReply OnControlToggleClicked();
	FReply OnSupervisorClicked();
	FReply OnVerifyClicked();
	FReply OnPanicClicked();
	FReply OnUndoClicked();
	FReply OnRedoClicked();
	FReply OnCopyResultClicked();
	FReply OnTemplateClicked();
	FReply OnSyncFormClicked();
	FReply OnArtifactsClicked();
	FReply OnCaptureUiClicked();
	FReply OnCancelClicked();
	FReply OnExportHistoryClicked();
	FReply OnAssetPickerAcceptClicked();
	FReply OnAssetPickerCancelClicked();

	ECheckBoxState GetDryRunCheckState() const;
	bool CanToggleDryRun() const;
	FText GetDryRunTooltip() const;
	FText GetRunHintText() const;
	void OnDryRunStateChanged(ECheckBoxState NewState);
	bool CanCancel() const;

	void RefreshHistoryFilterOptions();
	void ApplyHistoryFilters();
	FString FormatDryRunResult(const FString& RawText) const;
	FString FormatAbandonedResult(const FUEVControlCallResult& Result) const;
	void UpdateCompatibilityState();
	EVisibility GetBannerVisibility() const;
	FText GetBannerText() const;
	FSlateColor GetBannerColor() const;
	FString GetFooterText() const;

	void OpenAssetPicker(const FString& ParamName);
	void RefreshAssetPicker(const FString& InSearchText);
	void CloseAssetPicker();

	bool CanRun() const;
	bool CanUndo() const;
	bool CanRedo() const;
	bool CanToggleControl() const;
	bool CanStartSupervisor() const;
	bool CanVerify() const;

	FText GetControlButtonLabel() const;

	FText GetCallStatusLabel() const;
	FSlateColor GetStatusColor() const;
	FSlateColor GetResultBorderColor() const;
	FSlateColor GetResultTextColor() const;
	FSlateColor GetHistoryStatusColor(const FString& Status) const;
	FSlateColor GetPieColor() const;
	FSlateColor GetSelectionColor() const;
	FSlateColor GetRunButtonColor() const;
	void SetCallStatus(EUEVCallStatus NewStatus, const FString& Message);

	const FUEVControlAction* GetSelectedAction() const;
	const FUEVControlHistoryEntry* GetSelectedHistoryEntry() const;
	FString GetSelectionKey() const;
	FString FormatParamsHint() const;
	FString BuildParamsTemplate() const;
	static FString SingleLine(const FString& Text, int32 MaxLength = 120);
	static FSlateColor GetModeColor(const FString& Mode);

	TSharedPtr<FUEVControlClient> Client;

	TArray<FUEVControlTool> Tools;
	TArray<TSharedPtr<FUEVToolRow>> ToolRows;
	TArray<TSharedPtr<FUEVHistoryRow>> HistoryRows;
	TArray<TSharedPtr<FUEVParamRow>> ParamRows;
	FUEVControlHealth Health;

	FUEVControlCatalogInfo CatalogInfo;
	FString CompatibilityBanner;
	TArray<TSharedPtr<FUEVHistoryRow>> AllHistoryRows;
	TArray<TSharedPtr<FString>> HistoryToolOptions;
	TArray<TSharedPtr<FString>> HistoryActionOptions;
	TArray<TSharedPtr<FString>> HistoryStatusOptions;
	TSharedPtr<FString> HistoryToolSelection;
	TSharedPtr<FString> HistoryActionSelection;
	TSharedPtr<FString> HistoryStatusSelection;
	FString HistoryFilterTool;
	FString HistoryFilterAction;
	FString HistoryFilterStatus;
	/** True while combo selections are being synced from state, so OnSelectionChanged does not re-enter the refresh. */
	bool bSyncingHistoryFilters = false;
	TMap<FString, FString> UnsupportedReasons;
	TMap<FString, TSharedPtr<SMultiLineEditableTextBox>> RawParamEditors;
	TMap<FString, TSharedPtr<TArray<TSharedPtr<FString>>>> ParamComboOptions;

	bool bConnected = false;
	bool bPieRunning = false;
	bool bPieKnown = false;
	bool bHealthInFlight = false;
	bool bPieInFlight = false;
	/** Crash guard (panel-reentrancy): true while RefreshAll runs, so a nested refresh is skipped instead of recursing. */
	bool bRefreshInFlight = false;
	/** Crash guard (panel-reentrancy): depth of nested tool-row / param-form rebuilds. */
	int32 RebuildDepth = 0;
	/** Crash guard (panel-reentrancy): hard cap on nested rebuilds before the panel skips the work. */
	static constexpr int32 MaxRebuildDepth = 8;
	bool bRequestInFlight = false;
	bool bControlStartRequested = false;
	bool bControlServerOwnedLast = false;
	bool bDryRunRequested = false;
	bool bFormRefreshPending = false;
	double ControlStartRequestTime = 0.0;
	double LastHealthPoll = 0.0;
	double LastPiePoll = 0.0;

	int32 SelectedToolIndex = INDEX_NONE;
	int32 SelectedActionIndex = INDEX_NONE;
	bool bSelectedDirect = false;
	FString SelectedHistoryId;

	FString SearchText;
	FString ParamsJson;
	FString ResultText;
	FString StatusMessage;
	FString PendingToolName;
	FString PendingActionName;
	FString PendingCallId;
	EUEVCallStatus CallStatus = EUEVCallStatus::Idle;
	TMap<FString, FString> LastParams;

	TSharedPtr<SListView<TSharedPtr<FUEVToolRow>>> ToolListView;
	TSharedPtr<SListView<TSharedPtr<FUEVHistoryRow>>> HistoryListView;
	TSharedPtr<SMultiLineEditableTextBox> ParamsEditor;
	TSharedPtr<SMultiLineEditableTextBox> ResultEditor;
	TSharedPtr<SSearchBox> SearchBox;
	TSharedPtr<STextBlock> SelectionText;
	TSharedPtr<SVerticalBox> ParamFormBox;
	TSharedPtr<STextBlock> StatusText;
	TSharedPtr<STextBlock> ResultStatusText;
	TSharedPtr<STextBlock> ConnectionText;
	TSharedPtr<STextBlock> ProfileText;
	TSharedPtr<STextBlock> SupervisorText;
	TSharedPtr<STextBlock> PieText;
	TSharedPtr<SButton> RunButton;
	TSharedPtr<SCheckBox> DryRunCheckBox;
	TSharedPtr<STextBlock> FooterText;
	TSharedPtr<STextBlock> BannerText;
	TSharedPtr<SComboBox<TSharedPtr<FString>>> HistoryToolCombo;
	TSharedPtr<SComboBox<TSharedPtr<FString>>> HistoryActionCombo;
	TSharedPtr<SComboBox<TSharedPtr<FString>>> HistoryStatusCombo;

	TSharedPtr<SWindow> AssetPickerWindow;
	TSharedPtr<SSearchBox> AssetPickerSearchBox;
	TSharedPtr<SListView<TSharedPtr<FString>>> AssetPickerListView;
	TArray<TSharedPtr<FString>> AssetPickerRows;
	TSharedPtr<FString> AssetPickerSelection;
	TMap<FString, FString> AssetPickerLabels;
	FString AssetPickerParamName;
	bool bAssetPickerInFlight = false;
};
