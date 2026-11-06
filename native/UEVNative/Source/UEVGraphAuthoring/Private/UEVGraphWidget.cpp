// UEV Graph Authoring: designer-grade UMG authoring lane (1.7).
//
// Native tree operations behind the unreal.UEVGraphLibrary execute_graph_operation
// bridge. UE 4.27's UPanelWidget::InsertChildAt / ShiftChild and
// FWidgetBlueprintEditorUtils::{RenameWidget, DeleteWidgets} are WITH_EDITOR
// non-UFUNCTION / unexported, so the structural lane lives in C++ here.
//
// Operations (widget.*):
//   insert_child      create a widget and insert it into a panel (or as root)
//   reorder_child     move a widget inside its parent
//   duplicate         deep-copy a widget subtree under the same parent
//   rename            rename a widget and retarget bindings/variables/animations
//   remove_safe       remove a subtree and purge bindings/variables/animation bindings
//   reparent          move a widget to a different panel, preserving canvas layout
//   serialize_tree    deterministic tree dump with stable widget ids
//   validate          orphan bindings / missing assets / unreachable / duplicate names
//   set_style         read-modify-write font, color, button-state brushes
//   set_brush         read-modify-write a SlateBrush (texture, draw mode, margin, tint)
//   list_delegates    reflect multicast delegate properties on a widget class
//   list_bound_events read UWidgetBlueprint::Bindings
//   unbind_event      remove a bound event from UWidgetBlueprint::Bindings
//   screenshot        render the designer preview to a PNG
//   inspect_selection report the designer's current selection

#include "UEVGraphShared.h"

#include "Animation/WidgetAnimation.h"
#include "Animation/WidgetAnimationBinding.h"
#include "Blueprint/UserWidget.h"
#include "Blueprint/WidgetTree.h"
#include "Components/CanvasPanelSlot.h"
#include "Components/NamedSlotInterface.h"
#include "Components/PanelSlot.h"
#include "Components/PanelWidget.h"
#include "Components/Widget.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "Editor.h"
#include "Engine/TextureRenderTarget2D.h"
#include "Fonts/SlateFontInfo.h"
#include "Framework/Application/SlateApplication.h"
#include "HAL/FileManager.h"
#include "ImageUtils.h"
#include "K2Node_Variable.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/CompilerResultsLog.h"
#include "Kismet2/Kismet2NameValidators.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Misc/DateTime.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "MovieScene.h"
#include "MovieScenePossessable.h"
#include "RenderingThread.h"
#include "ScopedTransaction.h"
#include "Slate/WidgetRenderer.h"
#include "Styling/SlateBrush.h"
#include "Styling/SlateColor.h"
#include "Styling/SlateTypes.h"
#include "Subsystems/AssetEditorSubsystem.h"
#include "TextureResource.h"
#include "Toolkits/AssetEditorToolkit.h"
#include "UObject/UObjectIterator.h"
#include "UObject/UnrealType.h"
#include "WidgetBlueprint.h"
#include "WidgetBlueprintEditor.h"
#include "WidgetReference.h"
#include "Widgets/SWidget.h"

using UEVGraph::FJsonObjectPtr;
using UEVGraph::FJsonValuePtr;

namespace
{
	/** Structural edit counter per asset; used to prove the preview was refreshed. */
	TMap<TWeakObjectPtr<UWidgetBlueprint>, int32> GStructuralVersions;
	/** Last preview generation captured for an asset. */
	TMap<TWeakObjectPtr<UWidgetBlueprint>, int32> GCapturedVersions;

	int32 GetStructuralVersion(UWidgetBlueprint* Blueprint)
	{
		const int32* Found = GStructuralVersions.Find(TWeakObjectPtr<UWidgetBlueprint>(Blueprint));
		return Found ? *Found : 0;
	}

	void BumpStructuralVersion(UWidgetBlueprint* Blueprint)
	{
		int32& Version = GStructuralVersions.FindOrAdd(TWeakObjectPtr<UWidgetBlueprint>(Blueprint));
		++Version;
	}

	FJsonObjectPtr MakeWidgetResult(const FString& Operation, UWidgetBlueprint* Blueprint)
	{
		FJsonObjectPtr Result = UEVGraph::MakeObject();
		Result->SetBoolField(TEXT("success"), true);
		Result->SetStringField(TEXT("operation"), Operation);
		Result->SetStringField(TEXT("asset_path"), Blueprint ? Blueprint->GetPathName() : FString());
		Result->SetArrayField(TEXT("warnings"), TArray<TSharedPtr<FJsonValue>>());
		Result->SetBoolField(TEXT("saved"), false);
		Result->SetBoolField(TEXT("preview_invalidated"), false);
		return Result;
	}

	void AddWarning(const FJsonObjectPtr& Result, const FString& Message)
	{
		if (!Result.IsValid())
		{
			return;
		}
		TArray<TSharedPtr<FJsonValue>> Warnings;
		const TArray<TSharedPtr<FJsonValue>>* Existing = nullptr;
		if (Result->TryGetArrayField(TEXT("warnings"), Existing) && Existing)
		{
			Warnings = *Existing;
		}
		Warnings.Add(MakeShared<FJsonValueString>(Message));
		Result->SetArrayField(TEXT("warnings"), Warnings);
	}

	FString ReadStringAny(const FJsonObject& Object, const TArray<FString>& Names, const FString& Default = FString())
	{
		for (const FString& Name : Names)
		{
			const TSharedPtr<FJsonValue>* Found = Object.Values.Find(Name);
			if (Found && (*Found).IsValid() && (*Found)->Type == EJson::String)
			{
				return (*Found)->AsString();
			}
		}
		return Default;
	}

	double ReadNumberAny(const FJsonObject& Object, const TArray<FString>& Names, double Default)
	{
		for (const FString& Name : Names)
		{
			const TSharedPtr<FJsonValue>* Found = Object.Values.Find(Name);
			if (Found && (*Found).IsValid() && (*Found)->Type == EJson::Number)
			{
				return (*Found)->AsNumber();
			}
		}
		return Default;
	}

	bool ReadBoolAny(const FJsonObject& Object, const TArray<FString>& Names, bool bDefault)
	{
		for (const FString& Name : Names)
		{
			const TSharedPtr<FJsonValue>* Found = Object.Values.Find(Name);
			if (Found && (*Found).IsValid() && (*Found)->Type == EJson::Boolean)
			{
				return (*Found)->AsBool();
			}
		}
		return bDefault;
	}

	FJsonValuePtr ReadValueAny(const FJsonObject& Object, const TArray<FString>& Names)
	{
		for (const FString& Name : Names)
		{
			const TSharedPtr<FJsonValue>* Found = Object.Values.Find(Name);
			if (Found && (*Found).IsValid())
			{
				return *Found;
			}
		}
		return nullptr;
	}

	FJsonObjectPtr MakeVector2Record(const FVector2D& Vector)
	{
		FJsonObjectPtr Object = UEVGraph::MakeObject();
		Object->SetNumberField(TEXT("x"), Vector.X);
		Object->SetNumberField(TEXT("y"), Vector.Y);
		return Object;
	}

	FJsonObjectPtr MakeMarginRecord(const FMargin& Margin)
	{
		FJsonObjectPtr Object = UEVGraph::MakeObject();
		Object->SetNumberField(TEXT("left"), Margin.Left);
		Object->SetNumberField(TEXT("top"), Margin.Top);
		Object->SetNumberField(TEXT("right"), Margin.Right);
		Object->SetNumberField(TEXT("bottom"), Margin.Bottom);
		return Object;
	}

	FJsonObjectPtr MakeColorRecord(const FLinearColor& Color)
	{
		FJsonObjectPtr Object = UEVGraph::MakeObject();
		Object->SetNumberField(TEXT("r"), Color.R);
		Object->SetNumberField(TEXT("g"), Color.G);
		Object->SetNumberField(TEXT("b"), Color.B);
		Object->SetNumberField(TEXT("a"), Color.A);
		return Object;
	}

	/** FLinearColor as the struct's declared field names (R/G/B/A) for reflection writes. */
	FJsonObjectPtr MakeLinearColorStruct(const FLinearColor& Color)
	{
		FJsonObjectPtr Object = UEVGraph::MakeObject();
		Object->SetNumberField(TEXT("R"), Color.R);
		Object->SetNumberField(TEXT("G"), Color.G);
		Object->SetNumberField(TEXT("B"), Color.B);
		Object->SetNumberField(TEXT("A"), Color.A);
		return Object;
	}

	/** FMargin as declared field names (Left/Top/Right/Bottom). */
	FJsonObjectPtr MakeMarginStruct(const FMargin& Margin)
	{
		FJsonObjectPtr Object = UEVGraph::MakeObject();
		Object->SetNumberField(TEXT("Left"), Margin.Left);
		Object->SetNumberField(TEXT("Top"), Margin.Top);
		Object->SetNumberField(TEXT("Right"), Margin.Right);
		Object->SetNumberField(TEXT("Bottom"), Margin.Bottom);
		return Object;
	}

	FJsonObjectPtr MakeVector2Struct(const FVector2D& Vector)
	{
		FJsonObjectPtr Object = UEVGraph::MakeObject();
		Object->SetNumberField(TEXT("X"), Vector.X);
		Object->SetNumberField(TEXT("Y"), Vector.Y);
		return Object;
	}

	FJsonObjectPtr MakeAnchorsStruct(const FAnchors& Anchors)
	{
		FJsonObjectPtr Object = UEVGraph::MakeObject();
		Object->SetObjectField(TEXT("Minimum"), MakeVector2Struct(Anchors.Minimum));
		Object->SetObjectField(TEXT("Maximum"), MakeVector2Struct(Anchors.Maximum));
		return Object;
	}

	bool ReadVector2(const FJsonValuePtr& Value, FVector2D& Out)
	{
		if (!Value.IsValid())
		{
			return false;
		}
		const TArray<TSharedPtr<FJsonValue>>* Array = nullptr;
		if (Value->TryGetArray(Array) && Array && Array->Num() >= 2)
		{
			Out = FVector2D((*Array)[0]->AsNumber(), (*Array)[1]->AsNumber());
			return true;
		}
		const TSharedPtr<FJsonObject> Object = Value->AsObject();
		if (Object.IsValid())
		{
			Out = FVector2D(
				ReadNumberAny(*Object, { TEXT("x"), TEXT("X"), TEXT("width") }, Out.X),
				ReadNumberAny(*Object, { TEXT("y"), TEXT("Y"), TEXT("height") }, Out.Y));
			return true;
		}
		if (Value->Type == EJson::Number)
		{
			Out = FVector2D(Value->AsNumber(), Value->AsNumber());
			return true;
		}
		return false;
	}

	bool ReadMargin(const FJsonValuePtr& Value, FMargin& Out)
	{
		if (!Value.IsValid())
		{
			return false;
		}
		const TArray<TSharedPtr<FJsonValue>>* Array = nullptr;
		if (Value->TryGetArray(Array) && Array)
		{
			if (Array->Num() == 1)
			{
				Out = FMargin((*Array)[0]->AsNumber());
			}
			else if (Array->Num() == 2)
			{
				Out = FMargin((*Array)[0]->AsNumber(), (*Array)[1]->AsNumber());
			}
			else if (Array->Num() >= 4)
			{
				Out = FMargin((*Array)[0]->AsNumber(), (*Array)[1]->AsNumber(), (*Array)[2]->AsNumber(), (*Array)[3]->AsNumber());
			}
			else
			{
				return false;
			}
			return true;
		}
		const TSharedPtr<FJsonObject> Object = Value->AsObject();
		if (Object.IsValid())
		{
			Out = FMargin(
				ReadNumberAny(*Object, { TEXT("left"), TEXT("Left") }, Out.Left),
				ReadNumberAny(*Object, { TEXT("top"), TEXT("Top") }, Out.Top),
				ReadNumberAny(*Object, { TEXT("right"), TEXT("Right") }, Out.Right),
				ReadNumberAny(*Object, { TEXT("bottom"), TEXT("Bottom") }, Out.Bottom));
			return true;
		}
		if (Value->Type == EJson::Number)
		{
			Out = FMargin(Value->AsNumber());
			return true;
		}
		return false;
	}

	bool ReadLinearColor(const FJsonValuePtr& Value, FLinearColor& Out)
	{
		if (!Value.IsValid())
		{
			return false;
		}
		const TArray<TSharedPtr<FJsonValue>>* Array = nullptr;
		if (Value->TryGetArray(Array) && Array && Array->Num() >= 3)
		{
			Out = FLinearColor((*Array)[0]->AsNumber(), (*Array)[1]->AsNumber(), (*Array)[2]->AsNumber(), Array->Num() >= 4 ? (*Array)[3]->AsNumber() : 1.0f);
			return true;
		}
		const TSharedPtr<FJsonObject> Object = Value->AsObject();
		if (!Object.IsValid())
		{
			return false;
		}
		const FJsonValuePtr Nested = ReadValueAny(*Object, { TEXT("specified_color"), TEXT("specifiedColor"), TEXT("SpecifiedColor"), TEXT("color"), TEXT("value") });
		if (Nested.IsValid() && Nested->Type == EJson::Object)
		{
			return ReadLinearColor(Nested, Out);
		}
		Out = FLinearColor(
			ReadNumberAny(*Object, { TEXT("r"), TEXT("R"), TEXT("red") }, Out.R),
			ReadNumberAny(*Object, { TEXT("g"), TEXT("G"), TEXT("green") }, Out.G),
			ReadNumberAny(*Object, { TEXT("b"), TEXT("B"), TEXT("blue") }, Out.B),
			ReadNumberAny(*Object, { TEXT("a"), TEXT("A"), TEXT("alpha"), TEXT("opacity") }, Out.A));
		return true;
	}

	FProperty* FindPropertyOfClass(UClass* Class, const TArray<FString>& Names)
	{
		if (!Class)
		{
			return nullptr;
		}
		for (const FString& Name : Names)
		{
			if (FProperty* Property = Class->FindPropertyByName(FName(*Name)))
			{
				return Property;
			}
		}
		return nullptr;
	}

	FStructProperty* FindStructPropertyOfType(UClass* Class, UScriptStruct* StructType, const FString& PreferredName)
	{
		if (!Class || !StructType)
		{
			return nullptr;
		}
		FStructProperty* Fallback = nullptr;
		for (TFieldIterator<FStructProperty> It(Class); It; ++It)
		{
			FStructProperty* Property = *It;
			if (Property->Struct == StructType || (Property->Struct && Property->Struct->IsChildOf(StructType)))
			{
				if (Property->GetName().Equals(PreferredName, ESearchCase::IgnoreCase))
				{
					return Property;
				}
				if (!Fallback)
				{
					Fallback = Property;
				}
			}
		}
		return Fallback;
	}

	bool ReadBoolPropertyValue(UObject* Object, const FString& PropertyName, bool bDefault = false)
	{
		if (!Object)
		{
			return bDefault;
		}
		FProperty* Property = Object->GetClass()->FindPropertyByName(FName(*PropertyName));
		FBoolProperty* BoolProperty = CastField<FBoolProperty>(Property);
		if (!BoolProperty)
		{
			return bDefault;
		}
		return BoolProperty->GetPropertyValue_InContainer(Object);
	}

	bool TrySetPath(const FJsonObjectPtr& Result, UObject* Target, const FString& Path, const FJsonValuePtr& Value, const FString& Label)
	{
		if (!Target || !Value.IsValid() || Path.IsEmpty())
		{
			return false;
		}
		FString Error;
		if (UEVGraph::SetObjectPropertyPath(Target, Path, Value, Error))
		{
			return true;
		}
		AddWarning(Result, FString::Printf(TEXT("%s: %s"), Label.IsEmpty() ? *Path : *Label, *Error));
		return false;
	}

	UWidgetBlueprint* ResolveWidgetBlueprint(const FJsonObject& Args, FString& OutError)
	{
		const FString Identifier = UEVGraph::AssetIdentifier(Args);
		if (Identifier.IsEmpty())
		{
			OutError = TEXT("asset_path is required.");
			return nullptr;
		}
		UObject* Asset = UEVGraph::LoadAsset(Identifier, UWidgetBlueprint::StaticClass(), OutError);
		if (!Asset)
		{
			return nullptr;
		}
		UWidgetBlueprint* Blueprint = Cast<UWidgetBlueprint>(Asset);
		if (!Blueprint)
		{
			OutError = FString::Printf(TEXT("%s is not a WidgetBlueprint."), *Identifier);
			return nullptr;
		}
		if (!Blueprint->WidgetTree)
		{
			OutError = TEXT("WidgetBlueprint has no widget tree.");
			return nullptr;
		}
		return Blueprint;
	}

	FString ResolveWidgetNameArg(const FJsonObject& Args)
	{
		return ReadStringAny(Args, {
			TEXT("widget"),
			TEXT("widget_name"),
			TEXT("target_widget_name"),
			TEXT("widget_member_name"),
			TEXT("widget_component_name")
		});
	}

	UWidget* FindWidgetByName(UWidgetBlueprint* Blueprint, const FString& Name)
	{
		if (!Blueprint || !Blueprint->WidgetTree || Name.IsEmpty())
		{
			return nullptr;
		}
		return Blueprint->WidgetTree->FindWidget(FName(*Name));
	}

	UWidget* ResolveWidgetArg(UWidgetBlueprint* Blueprint, const FJsonObject& Args, FString& OutError)
	{
		const FString Name = ResolveWidgetNameArg(Args);
		if (Name.IsEmpty())
		{
			OutError = TEXT("widget is required.");
			return nullptr;
		}
		UWidget* Widget = FindWidgetByName(Blueprint, Name);
		if (!Widget)
		{
			OutError = FString::Printf(TEXT("Widget not found: %s"), *Name);
		}
		return Widget;
	}

	UPanelWidget* ResolveParentArg(UWidgetBlueprint* Blueprint, const FJsonObject& Args, FString& OutError)
	{
		const FString ParentName = ReadStringAny(Args, { TEXT("parent"), TEXT("parent_widget_name"), TEXT("parent_name") });
		if (ParentName.IsEmpty())
		{
			return nullptr;
		}
		UWidget* ParentWidget = FindWidgetByName(Blueprint, ParentName);
		if (!ParentWidget)
		{
			OutError = FString::Printf(TEXT("Parent widget not found: %s"), *ParentName);
			return nullptr;
		}
		UPanelWidget* Panel = Cast<UPanelWidget>(ParentWidget);
		if (!Panel)
		{
			OutError = FString::Printf(TEXT("Widget '%s' is not a panel widget and cannot contain child widgets."), *ParentName);
		}
		return Panel;
	}

	int32 ReadIndexArg(const FJsonObject& Args, int32 Default)
	{
		const TSharedPtr<FJsonValue>* Found = Args.Values.Find(TEXT("index"));
		if (Found && (*Found).IsValid() && (*Found)->Type == EJson::Number)
		{
			return static_cast<int32>((*Found)->AsNumber());
		}
		return Default;
	}

	UPanelSlot* GetWidgetSlot(UWidget* Widget)
	{
		return Widget ? Widget->Slot : nullptr;
	}

	FString BuildWidgetId(UWidgetBlueprint* Blueprint, UWidget* Widget)
	{
		TArray<FString> Segments;
		TSet<UWidget*> Guard;
		UWidget* Current = Widget;
		while (Current && !Guard.Contains(Current))
		{
			Guard.Add(Current);
			Segments.Insert(TEXT("/") + Current->GetName(), 0);
			Current = Current->GetParent();
		}
		return FString::Printf(TEXT("%s#%s"), Blueprint ? *Blueprint->GetPathName() : TEXT(""), *FString::Join(Segments, TEXT("")));
	}

	FJsonObjectPtr SerializeSlotRecord(UPanelSlot* Slot)
	{
		FJsonObjectPtr Object = UEVGraph::MakeObject();
		if (!Slot)
		{
			return Object;
		}
		Object->SetStringField(TEXT("slot_class"), Slot->GetClass()->GetName());
		if (UCanvasPanelSlot* CanvasSlot = Cast<UCanvasPanelSlot>(Slot))
		{
			const FAnchorData& Layout = CanvasSlot->LayoutData;
			Object->SetObjectField(TEXT("anchors"), MakeAnchorsStruct(Layout.Anchors));
			Object->SetObjectField(TEXT("offsets"), MakeMarginRecord(Layout.Offsets));
			Object->SetObjectField(TEXT("alignment"), MakeVector2Record(Layout.Alignment));
			Object->SetNumberField(TEXT("z_order"), CanvasSlot->ZOrder);
			Object->SetBoolField(TEXT("auto_size"), CanvasSlot->bAutoSize);
		}
		else
		{
			TArray<TSharedPtr<FJsonValue>> Properties;
			for (TFieldIterator<FProperty> It(Slot->GetClass()); It; ++It)
			{
				FProperty* Property = *It;
				if (!Property->HasAnyPropertyFlags(CPF_Edit) || Property->HasAnyPropertyFlags(CPF_Transient))
				{
					continue;
				}
				FString ValueText;
				Property->ExportTextItem(ValueText, Property->ContainerPtrToValuePtr<void>(Slot), nullptr, Slot, PPF_None);
				FJsonObjectPtr Entry = UEVGraph::MakeObject();
				Entry->SetStringField(TEXT("name"), Property->GetName());
				Entry->SetStringField(TEXT("type"), Property->GetCPPType());
				Entry->SetStringField(TEXT("value"), ValueText);
				Properties.Add(MakeShared<FJsonValueObject>(Entry));
			}
			Object->SetArrayField(TEXT("properties"), Properties);
		}
		return Object;
	}

	FJsonObjectPtr SerializeWidgetRecord(UWidgetBlueprint* Blueprint, UWidget* Widget)
	{
		FJsonObjectPtr Record = UEVGraph::MakeObject();
		if (!Widget)
		{
			return Record;
		}
		UWidget* Parent = Widget->GetParent();
		int32 Index = INDEX_NONE;
		if (UPanelWidget* ParentPanel = Cast<UPanelWidget>(Parent))
		{
			Index = ParentPanel->GetChildIndex(Widget);
		}
		else if (Blueprint && Blueprint->WidgetTree && Blueprint->WidgetTree->RootWidget == Widget)
		{
			Index = 0;
		}
		UPanelSlot* Slot = GetWidgetSlot(Widget);
		Record->SetStringField(TEXT("name"), Widget->GetName());
		Record->SetStringField(TEXT("id"), BuildWidgetId(Blueprint, Widget));
		Record->SetStringField(TEXT("class"), Widget->GetClass()->GetName());
		Record->SetStringField(TEXT("parent"), Parent ? Parent->GetName() : FString());
		Record->SetNumberField(TEXT("index"), Index);
		Record->SetStringField(TEXT("slot_class"), Slot ? Slot->GetClass()->GetName() : FString());
		Record->SetBoolField(TEXT("is_variable"), ReadBoolPropertyValue(Widget, TEXT("bIsVariable")));
		Record->SetBoolField(TEXT("is_root"), Blueprint && Blueprint->WidgetTree && Blueprint->WidgetTree->RootWidget == Widget);
		const FString& DisplayLabel = Widget->GetDisplayLabel();
		if (!DisplayLabel.IsEmpty())
		{
			Record->SetStringField(TEXT("display_label"), DisplayLabel);
		}
		if (Slot)
		{
			Record->SetObjectField(TEXT("slot"), SerializeSlotRecord(Slot));
		}
		return Record;
	}

	FWidgetBlueprintEditor* FindWidgetEditor(UWidgetBlueprint* Blueprint, bool bOpenIfMissing)
	{
		if (!GEditor || !Blueprint)
		{
			return nullptr;
		}
		UAssetEditorSubsystem* Subsystem = GEditor->GetEditorSubsystem<UAssetEditorSubsystem>();
		if (!Subsystem)
		{
			return nullptr;
		}
		IAssetEditorInstance* Instance = Subsystem->FindEditorForAsset(Blueprint, false);
		if (!Instance && bOpenIfMissing)
		{
			Subsystem->OpenEditorForAssets(TArray<UObject*>{ Blueprint });
			Instance = Subsystem->FindEditorForAsset(Blueprint, false);
		}
		if (!Instance)
		{
			return nullptr;
		}
		// A UWidgetBlueprint is only ever opened by FWidgetBlueprintEditor, and IAssetEditorInstance
		// is FAssetEditorToolkit's first base, so this downcast is offset-safe.
		return static_cast<FWidgetBlueprintEditor*>(Instance);
	}

	bool RefuseDuringPie(const FJsonObjectPtr& Result)
	{
		int32 WorldCount = 0;
		if (!UEVGraph::IsPlayInEditorActive(WorldCount) || UEVGraph::UnsafeOperationsAllowed())
		{
			return false;
		}
		const FJsonObjectPtr Refusal = UEVGraph::MakeGuardRefusal(
			TEXT("umg_authoring_during_pie"),
			TEXT("UMG authoring while Play-In-Editor is running"),
			TEXT("Structural UMG edits are refused while a Play-In-Editor session is alive."),
			TEXT("Stop Play-In-Editor, or set UEV_ALLOW_UNSAFE_OPERATIONS=1 to override."));
		for (const auto& Pair : Refusal->Values)
		{
			Result->SetField(Pair.Key, Pair.Value);
		}
		return true;
	}

	/** Applies an optional layout object to a slot using reflected leaf writes. */
	bool ApplyLayoutToSlot(UWidget* Widget, const TSharedPtr<FJsonObject>& Layout, const FJsonObjectPtr& Result)
	{
		if (!Layout.IsValid() || !Widget)
		{
			return false;
		}
		UPanelSlot* Slot = GetWidgetSlot(Widget);
		if (!Slot)
		{
			AddWarning(Result, FString::Printf(TEXT("layout ignored for root widget '%s': it has no slot."), *Widget->GetName()));
			return false;
		}
		const FString Prefix = TEXT("LayoutData.");
		bool bApplied = false;

		const FJsonValuePtr AnchorsValue = ReadValueAny(*Layout, { TEXT("anchors"), TEXT("anchor") });
		FVector2D Minimum;
		FVector2D Maximum;
		if (AnchorsValue.IsValid() && AnchorsValue->Type == EJson::Object)
		{
			const TSharedPtr<FJsonObject> AnchorsObject = AnchorsValue->AsObject();
			const FJsonValuePtr MinimumValue = ReadValueAny(*AnchorsObject, { TEXT("minimum"), TEXT("min"), TEXT("Minimum") });
			const FJsonValuePtr MaximumValue = ReadValueAny(*AnchorsObject, { TEXT("maximum"), TEXT("max"), TEXT("Maximum") });
			if (ReadVector2(MinimumValue, Minimum) && ReadVector2(MaximumValue, Maximum))
			{
				FAnchors Anchors;
				Anchors.Minimum = Minimum;
				Anchors.Maximum = Maximum;
				bApplied |= TrySetPath(Result, Slot, Prefix + TEXT("Anchors"), MakeShared<FJsonValueObject>(MakeAnchorsStruct(Anchors)), TEXT("layout.anchors"));
			}
		}
		else
		{
			const FJsonValuePtr MinValue = ReadValueAny(*Layout, { TEXT("anchor_min"), TEXT("minimum") });
			const FJsonValuePtr MaxValue = ReadValueAny(*Layout, { TEXT("anchor_max"), TEXT("maximum") });
			if (ReadVector2(MinValue, Minimum) && ReadVector2(MaxValue, Maximum))
			{
				FAnchors Anchors;
				Anchors.Minimum = Minimum;
				Anchors.Maximum = Maximum;
				bApplied |= TrySetPath(Result, Slot, Prefix + TEXT("Anchors"), MakeShared<FJsonValueObject>(MakeAnchorsStruct(Anchors)), TEXT("layout.anchors"));
			}
		}

		const FJsonValuePtr OffsetsValue = ReadValueAny(*Layout, { TEXT("offsets") });
		FMargin Offsets;
		if (ReadMargin(OffsetsValue, Offsets))
		{
			bApplied |= TrySetPath(Result, Slot, Prefix + TEXT("Offsets"), MakeShared<FJsonValueObject>(MakeMarginStruct(Offsets)), TEXT("layout.offsets"));
		}
		else
		{
			FVector2D Position;
			FVector2D Size;
			const bool bHasPosition = ReadVector2(ReadValueAny(*Layout, { TEXT("position"), TEXT("location") }), Position);
			const bool bHasSize = ReadVector2(ReadValueAny(*Layout, { TEXT("size") }), Size);
			if (bHasPosition || bHasSize)
			{
				FVector2D CurrentPosition(0.0f, 0.0f);
				FVector2D CurrentSize(100.0f, 100.0f);
				if (UCanvasPanelSlot* CanvasSlot = Cast<UCanvasPanelSlot>(Slot))
				{
					CurrentPosition = FVector2D(CanvasSlot->LayoutData.Offsets.Left, CanvasSlot->LayoutData.Offsets.Top);
					CurrentSize = FVector2D(
						CanvasSlot->LayoutData.Offsets.Right - CanvasSlot->LayoutData.Offsets.Left,
						CanvasSlot->LayoutData.Offsets.Bottom - CanvasSlot->LayoutData.Offsets.Top);
				}
				if (bHasPosition)
				{
					CurrentPosition = Position;
				}
				if (bHasSize)
				{
					CurrentSize = Size;
				}
				const FMargin Computed(CurrentPosition.X, CurrentPosition.Y, CurrentPosition.X + CurrentSize.X, CurrentPosition.Y + CurrentSize.Y);
				bApplied |= TrySetPath(Result, Slot, Prefix + TEXT("Offsets"), MakeShared<FJsonValueObject>(MakeMarginStruct(Computed)), TEXT("layout.position/size"));
			}
		}

		const FJsonValuePtr AlignmentValue = ReadValueAny(*Layout, { TEXT("alignment") });
		FVector2D Alignment;
		if (ReadVector2(AlignmentValue, Alignment))
		{
			bApplied |= TrySetPath(Result, Slot, Prefix + TEXT("Alignment"), MakeShared<FJsonValueObject>(MakeVector2Struct(Alignment)), TEXT("layout.alignment"));
		}

		const TSharedPtr<FJsonValue>* ZOrderValue = Layout->Values.Find(TEXT("z_order"));
		if (ZOrderValue && (*ZOrderValue).IsValid() && (*ZOrderValue)->Type == EJson::Number)
		{
			bApplied |= TrySetPath(Result, Slot, TEXT("ZOrder"), MakeShared<FJsonValueNumber>((*ZOrderValue)->AsNumber()), TEXT("layout.z_order"));
		}

		const FJsonValuePtr PaddingValue = ReadValueAny(*Layout, { TEXT("padding") });
		FMargin Padding;
		if (ReadMargin(PaddingValue, Padding))
		{
			bApplied |= TrySetPath(Result, Slot, TEXT("Padding"), MakeShared<FJsonValueObject>(MakeMarginStruct(Padding)), TEXT("layout.padding"));
		}

		const FJsonValuePtr HorizontalValue = ReadValueAny(*Layout, { TEXT("horizontal_alignment"), TEXT("horizontal") });
		if (HorizontalValue.IsValid())
		{
			bApplied |= TrySetPath(Result, Slot, TEXT("HorizontalAlignment"), HorizontalValue, TEXT("layout.horizontal_alignment"));
		}
		const FJsonValuePtr VerticalValue = ReadValueAny(*Layout, { TEXT("vertical_alignment"), TEXT("vertical") });
		if (VerticalValue.IsValid())
		{
			bApplied |= TrySetPath(Result, Slot, TEXT("VerticalAlignment"), VerticalValue, TEXT("layout.vertical_alignment"));
		}

		const FJsonValuePtr SizeRuleValue = ReadValueAny(*Layout, { TEXT("size_rule") });
		const FJsonValuePtr FillValue = ReadValueAny(*Layout, { TEXT("fill") });
		if (SizeRuleValue.IsValid() || FillValue.IsValid())
		{
			FJsonObjectPtr SizeStruct = UEVGraph::MakeObject();
			if (SizeRuleValue.IsValid())
			{
				SizeStruct->SetStringField(TEXT("SizeRule"), SizeRuleValue->AsString());
			}
			if (FillValue.IsValid())
			{
				SizeStruct->SetNumberField(TEXT("Value"), FillValue->AsNumber());
			}
			bApplied |= TrySetPath(Result, Slot, TEXT("Size"), MakeShared<FJsonValueObject>(SizeStruct), TEXT("layout.size_rule"));
		}
		return bApplied;
	}
}

namespace
{
	FJsonObjectPtr ErrorResult(const FString& Operation, const FString& Message, UWidgetBlueprint* Blueprint = nullptr)
	{
		FJsonObjectPtr Result = MakeWidgetResult(Operation, Blueprint);
		Result->SetBoolField(TEXT("success"), false);
		Result->SetStringField(TEXT("message"), Message);
		return Result;
	}

	FJsonObjectPtr CompleteWidgetEdit(UWidgetBlueprint* Blueprint, const FJsonObject& Args, FJsonObjectPtr Result, bool bCompile = true)
	{
		BumpStructuralVersion(Blueprint);
		FWidgetBlueprintEditor* Editor = FindWidgetEditor(Blueprint, false);
		if (Editor)
		{
			Editor->InvalidatePreview(false);
			Result->SetBoolField(TEXT("preview_invalidated"), true);
		}
		FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
		Result->SetNumberField(TEXT("preview_generation"), GetStructuralVersion(Blueprint));
		if (bCompile)
		{
			FJsonObjectPtr CompileResult;
			const bool bCompiled = UEVGraph::CompileBlueprint(Blueprint, CompileResult);
			if (CompileResult.IsValid())
			{
				Result->SetObjectField(TEXT("compile"), CompileResult);
			}
			Result->SetBoolField(TEXT("compiled"), bCompiled);
			if (!bCompiled)
			{
				Result->SetBoolField(TEXT("success"), false);
				Result->SetStringField(TEXT("message"), TEXT("The widget edit left the blueprint with compile errors."));
			}
		}
		return UEVGraph::FinalizeAssetEdit(Blueprint, Args, Result);
	}

	FString MakeUniqueWidgetName(UWidgetBlueprint* Blueprint, const FString& RequestedBase)
	{
		FString Base = RequestedBase.IsEmpty() ? TEXT("Widget") : RequestedBase;
		Base = MakeObjectNameFromDisplayLabel(Base, FName(*Base)).ToString();
		if (Base.IsEmpty())
		{
			Base = TEXT("Widget");
		}
		FString Candidate = Base;
		int32 Suffix = 0;
		while (FindWidgetByName(Blueprint, Candidate))
		{
			++Suffix;
			Candidate = FString::Printf(TEXT("%s_%d"), *Base, Suffix);
			if (Suffix > 999)
			{
				break;
			}
		}
		return Candidate;
	}

	UClass* ResolveWidgetClass(const FString& ClassName, FString& OutError)
	{
		FString Error;
		UClass* WidgetClass = UEVGraph::ResolveClass(ClassName, UWidget::StaticClass(), Error);
		if (!WidgetClass && !ClassName.Contains(TEXT("/")) && !ClassName.Contains(TEXT(".")))
		{
			WidgetClass = LoadObject<UClass>(nullptr, *FString::Printf(TEXT("/Script/UMG.%s"), *ClassName));
		}
		if (!WidgetClass)
		{
			OutError = Error.IsEmpty() ? FString::Printf(TEXT("Class not found: %s"), *ClassName) : Error;
			return nullptr;
		}
		if (WidgetClass->IsChildOf(UUserWidget::StaticClass()))
		{
			OutError = FString::Printf(TEXT("Class %s is a UserWidget subclass; nested UserWidget creation is not supported by the native tree lane."), *ClassName);
			return nullptr;
		}
		return WidgetClass;
	}

	FJsonObjectPtr HandleInsertChild(const FJsonObject& Args)
	{
		const FString Operation = TEXT("insert_child");
		FJsonObjectPtr Result = MakeWidgetResult(Operation, nullptr);
		if (RefuseDuringPie(Result))
		{
			return Result;
		}
		FString Error;
		UWidgetBlueprint* Blueprint = ResolveWidgetBlueprint(Args, Error);
		if (!Blueprint)
		{
			return ErrorResult(Operation, Error);
		}
		Result->SetStringField(TEXT("asset_path"), Blueprint->GetPathName());
		Result->SetStringField(TEXT("asset_path"), Blueprint->GetPathName());

		const FString ClassName = ReadStringAny(Args, { TEXT("class"), TEXT("widget_class"), TEXT("class_name"), TEXT("type") });
		if (ClassName.IsEmpty())
		{
			return ErrorResult(Operation, TEXT("class is required (for example TextBlock, Button, CanvasPanel)."), Blueprint);
		}
		UClass* WidgetClass = ResolveWidgetClass(ClassName, Error);
		if (!WidgetClass)
		{
			return ErrorResult(Operation, Error, Blueprint);
		}

		UPanelWidget* Parent = ResolveParentArg(Blueprint, Args, Error);
		if (!Error.IsEmpty())
		{
			return ErrorResult(Operation, Error, Blueprint);
		}
		const FString RequestedName = ReadStringAny(Args, { TEXT("name"), TEXT("widget_name"), TEXT("new_name"), TEXT("widget") });
		const FString NewName = MakeUniqueWidgetName(Blueprint, RequestedName.IsEmpty() ? WidgetClass->GetName() : RequestedName);
		if (!RequestedName.IsEmpty() && RequestedName != NewName)
		{
			AddWarning(Result, FString::Printf(TEXT("Requested widget name '%s' was adjusted to '%s' to stay unique."), *RequestedName, *NewName));
		}

		UWidgetTree* Tree = Blueprint->WidgetTree;
		if (!Parent && Tree->RootWidget)
		{
			return ErrorResult(Operation, FString::Printf(TEXT("parent is required because the tree already has a root widget (%s)."), *Tree->RootWidget->GetName()), Blueprint);
		}

		const int32 RequestedIndex = ReadIndexArg(Args, INDEX_NONE);
		const FScopedTransaction Transaction(FText::FromString(TEXT("UEV: insert widget")));
		Tree->SetFlags(RF_Transactional);
		Tree->Modify();
		Blueprint->Modify();

		UWidget* NewWidget = NewObject<UWidget>(Tree, WidgetClass, FName(*NewName), RF_Transactional);
		if (!NewWidget)
		{
			return ErrorResult(Operation, TEXT("NewObject returned null for the requested widget class."), Blueprint);
		}
		NewWidget->SetFlags(RF_Transactional);
		int32 AppliedIndex = 0;
		if (Parent)
		{
			Parent->Modify();
			const int32 ChildCount = Parent->GetChildrenCount();
			AppliedIndex = RequestedIndex == INDEX_NONE ? ChildCount : FMath::Clamp(RequestedIndex, 0, ChildCount);
			if (RequestedIndex != INDEX_NONE && RequestedIndex != AppliedIndex)
			{
				AddWarning(Result, FString::Printf(TEXT("Requested index %d was clamped to %d for parent '%s'."), RequestedIndex, AppliedIndex, *Parent->GetName()));
			}
			if (!Parent->InsertChildAt(AppliedIndex, NewWidget))
			{
				return ErrorResult(Operation, FString::Printf(TEXT("Parent '%s' rejected the child (it may not allow multiple children)."), *Parent->GetName()), Blueprint);
			}
		}
		else
		{
			Tree->RootWidget = NewWidget;
			AppliedIndex = 0;
		}

		if (FWidgetBlueprintEditor* Editor = FindWidgetEditor(Blueprint, false))
		{
			NewWidget->SetDesignerFlags(Editor->GetCurrentDesignerFlags());
		}

		const TSharedPtr<FJsonObject> Layout = UEVGraph::GetObject(Args, TEXT("layout"));
		if (Layout.IsValid())
		{
			ApplyLayoutToSlot(NewWidget, Layout, Result);
		}
		else
		{
			FVector2D Position;
			FVector2D Size;
			const bool bHasPosition = ReadVector2(ReadValueAny(Args, { TEXT("position") }), Position);
			const bool bHasSize = ReadVector2(ReadValueAny(Args, { TEXT("size") }), Size);
			const int32 ZOrder = static_cast<int32>(ReadNumberAny(Args, { TEXT("z_order") }, 0.0));
			if (bHasPosition || bHasSize)
			{
				const FVector2D EffectivePosition = bHasPosition ? Position : FVector2D(0.0f, 0.0f);
				const FVector2D EffectiveSize = bHasSize ? Size : FVector2D(100.0f, 100.0f);
				const FMargin Offsets(EffectivePosition.X, EffectivePosition.Y, EffectivePosition.X + EffectiveSize.X, EffectivePosition.Y + EffectiveSize.Y);
				UPanelSlot* Slot = GetWidgetSlot(NewWidget);
				if (Slot)
				{
					TrySetPath(Result, Slot, TEXT("LayoutData.Offsets"), MakeShared<FJsonValueObject>(MakeMarginStruct(Offsets)), TEXT("position/size"));
					if (ZOrder != 0)
					{
						TrySetPath(Result, Slot, TEXT("ZOrder"), MakeShared<FJsonValueNumber>(ZOrder), TEXT("z_order"));
					}
				}
			}
		}

		Result->SetObjectField(TEXT("widget"), SerializeWidgetRecord(Blueprint, NewWidget));
		Result->SetStringField(TEXT("class"), WidgetClass->GetName());
		Result->SetNumberField(TEXT("index"), AppliedIndex);
		Result->SetBoolField(TEXT("created_as_root"), Parent == nullptr);
		return CompleteWidgetEdit(Blueprint, Args, Result);
	}

	FJsonObjectPtr HandleReorderChild(const FJsonObject& Args)
	{
		const FString Operation = TEXT("reorder_child");
		FJsonObjectPtr Result = MakeWidgetResult(Operation, nullptr);
		if (RefuseDuringPie(Result))
		{
			return Result;
		}
		FString Error;
		UWidgetBlueprint* Blueprint = ResolveWidgetBlueprint(Args, Error);
		if (!Blueprint)
		{
			return ErrorResult(Operation, Error);
		}
		Result->SetStringField(TEXT("asset_path"), Blueprint->GetPathName());
		UWidget* Widget = ResolveWidgetArg(Blueprint, Args, Error);
		if (!Widget)
		{
			return ErrorResult(Operation, Error, Blueprint);
		}
		UPanelWidget* Parent = Widget->GetParent();
		if (!Parent)
		{
			return ErrorResult(Operation, FString::Printf(TEXT("Widget '%s' is the root widget and cannot be reordered."), *Widget->GetName()), Blueprint);
		}
		if (!Args.Values.Contains(TEXT("index")))
		{
			return ErrorResult(Operation, TEXT("index is required."), Blueprint);
		}
		const int32 CurrentIndex = Parent->GetChildIndex(Widget);
		const int32 RequestedIndex = ReadIndexArg(Args, CurrentIndex);
		const int32 TargetIndex = FMath::Clamp(RequestedIndex, 0, Parent->GetChildrenCount() - 1);
		if (TargetIndex != RequestedIndex)
		{
			AddWarning(Result, FString::Printf(TEXT("Requested index %d was clamped to %d."), RequestedIndex, TargetIndex));
		}
		if (TargetIndex == CurrentIndex)
		{
			Result->SetObjectField(TEXT("widget"), SerializeWidgetRecord(Blueprint, Widget));
			Result->SetNumberField(TEXT("index"), CurrentIndex);
			return CompleteWidgetEdit(Blueprint, Args, Result, false);
		}

		const FScopedTransaction Transaction(FText::FromString(TEXT("UEV: reorder widget")));
		Parent->SetFlags(RF_Transactional);
		Parent->Modify();
		Widget->Modify();
		Parent->ShiftChild(TargetIndex, Widget);
		Result->SetObjectField(TEXT("widget"), SerializeWidgetRecord(Blueprint, Widget));
		Result->SetStringField(TEXT("parent"), Parent->GetName());
		Result->SetNumberField(TEXT("index"), Parent->GetChildIndex(Widget));
		Result->SetNumberField(TEXT("previous_index"), CurrentIndex);
		return CompleteWidgetEdit(Blueprint, Args, Result);
	}

	UWidget* DuplicateWidgetSubtree(
		UWidgetBlueprint* Blueprint,
		UWidget* Source,
		UPanelWidget* Destination,
		const FString& RequestedName,
		bool bDeep,
		const FJsonObjectPtr& Result,
		TArray<FString>& OutNames)
	{
		UWidgetTree* Tree = Blueprint->WidgetTree;
		UWidget* Copy = DuplicateObject<UWidget>(Source, Tree);
		if (!Copy)
		{
			return nullptr;
		}
		Copy->SetFlags(RF_Transactional);
		// DuplicateObject copies the panel's Slots array but not slot contents, so the copied
		// panel would keep referencing the ORIGINAL children. Empty the copied slot list (via
		// reflection, without touching Content->Slot) and let the recursion below build real
		// child duplicates instead of reaching into the originals.
		if (UPanelWidget* CopiedPanel = Cast<UPanelWidget>(Copy))
		{
			if (FArrayProperty* SlotsProperty = FindFProperty<FArrayProperty>(CopiedPanel->GetClass(), TEXT("Slots")))
			{
				FScriptArrayHelper SlotHelper(SlotsProperty, SlotsProperty->ContainerPtrToValuePtr<void>(CopiedPanel));
				SlotHelper.EmptyValues();
			}
		}
		const FString BaseName = RequestedName.IsEmpty() ? Source->GetName() + TEXT("_Copy") : RequestedName;
		const FString UniqueName = MakeUniqueWidgetName(Blueprint, BaseName);
		if (UniqueName != BaseName)
		{
			AddWarning(Result, FString::Printf(TEXT("Duplicate name '%s' was adjusted to '%s'."), *BaseName, *UniqueName));
		}
		Copy->Rename(*UniqueName, Tree, REN_ForceNoResetLoaders | REN_DontCreateRedirectors);
		Copy->SetDisplayLabel(UniqueName);
		FBoolProperty* VariableProperty = CastField<FBoolProperty>(Copy->GetClass()->FindPropertyByName(TEXT("bIsVariable")));
		if (VariableProperty)
		{
			VariableProperty->SetPropertyValue_InContainer(Copy, false);
		}

		if (!Destination)
		{
			Tree->RootWidget = Copy;
		}
		else if (!Destination->InsertChildAt(Destination->GetChildrenCount(), Copy))
		{
			AddWarning(Result, FString::Printf(TEXT("Could not insert duplicate '%s' into '%s'."), *UniqueName, *Destination->GetName()));
			return nullptr;
		}

		if (UCanvasPanelSlot* SourceCanvas = Cast<UCanvasPanelSlot>(Source->Slot))
		{
			if (UCanvasPanelSlot* CopyCanvas = Cast<UCanvasPanelSlot>(Copy->Slot))
			{
				CopyCanvas->Modify();
				CopyCanvas->LayoutData = SourceCanvas->LayoutData;
				CopyCanvas->ZOrder = SourceCanvas->ZOrder;
				CopyCanvas->bAutoSize = SourceCanvas->bAutoSize;
			}
		}

		OutNames.Add(Copy->GetName());

		UPanelWidget* SourcePanel = Cast<UPanelWidget>(Source);
		UPanelWidget* CopyPanel = Cast<UPanelWidget>(Copy);
		if (bDeep && SourcePanel)
		{
			if (!CopyPanel)
			{
				AddWarning(Result, FString::Printf(TEXT("Duplicate of '%s' is not a panel; children were skipped."), *Source->GetName()));
			}
			else
			{
				const int32 ChildCount = SourcePanel->GetChildrenCount();
				for (int32 ChildIndex = 0; ChildIndex < ChildCount; ++ChildIndex)
				{
					UWidget* SourceChild = SourcePanel->GetChildAt(ChildIndex);
					if (SourceChild)
					{
						DuplicateWidgetSubtree(Blueprint, SourceChild, CopyPanel, FString(), true, Result, OutNames);
					}
				}
			}
		}
		else if (!bDeep && SourcePanel && SourcePanel->GetChildrenCount() > 0)
		{
			AddWarning(Result, FString::Printf(TEXT("Shallow duplicate of '%s' omitted %d child widget(s)."), *Source->GetName(), SourcePanel->GetChildrenCount()));
		}
		return Copy;
	}

	FJsonObjectPtr HandleDuplicate(const FJsonObject& Args)
	{
		const FString Operation = TEXT("duplicate");
		FJsonObjectPtr Result = MakeWidgetResult(Operation, nullptr);
		if (RefuseDuringPie(Result))
		{
			return Result;
		}
		FString Error;
		UWidgetBlueprint* Blueprint = ResolveWidgetBlueprint(Args, Error);
		if (!Blueprint)
		{
			return ErrorResult(Operation, Error);
		}
		Result->SetStringField(TEXT("asset_path"), Blueprint->GetPathName());
		UWidget* Source = ResolveWidgetArg(Blueprint, Args, Error);
		if (!Source)
		{
			return ErrorResult(Operation, Error, Blueprint);
		}
		if (Source == Blueprint->WidgetTree->RootWidget)
		{
			return ErrorResult(Operation, TEXT("Duplicating the root widget is not supported; duplicate a child panel instead."), Blueprint);
		}
		UPanelWidget* Parent = Source->GetParent();
		if (!Parent)
		{
			return ErrorResult(Operation, FString::Printf(TEXT("Widget '%s' has no parent panel to duplicate into."), *Source->GetName()), Blueprint);
		}
		const bool bDeep = ReadBoolAny(Args, { TEXT("deep") }, true);
		const FString RequestedName = ReadStringAny(Args, { TEXT("new_name"), TEXT("name") });

		const FScopedTransaction Transaction(FText::FromString(TEXT("UEV: duplicate widget")));
		Parent->SetFlags(RF_Transactional);
		Parent->Modify();
		Blueprint->WidgetTree->Modify();
		Blueprint->Modify();
		TArray<FString> CreatedNames;
		UWidget* Copy = DuplicateWidgetSubtree(Blueprint, Source, Parent, RequestedName, bDeep, Result, CreatedNames);
		if (!Copy)
		{
			return ErrorResult(Operation, FString::Printf(TEXT("Failed to duplicate '%s'."), *Source->GetName()), Blueprint);
		}
		Result->SetObjectField(TEXT("widget"), SerializeWidgetRecord(Blueprint, Copy));
		Result->SetStringField(TEXT("source_widget"), Source->GetName());
		Result->SetNumberField(TEXT("duplicated_count"), CreatedNames.Num());
		TArray<TSharedPtr<FJsonValue>> Names;
		for (const FString& Name : CreatedNames)
		{
			Names.Add(MakeShared<FJsonValueString>(Name));
		}
		Result->SetArrayField(TEXT("duplicated_widgets"), Names);
		return CompleteWidgetEdit(Blueprint, Args, Result);
	}

	FString ValidatorResultMessage(EValidatorResult ValidatorResult)
	{
		switch (ValidatorResult)
		{
		case EValidatorResult::ContainsInvalidCharacters:
			return TEXT("the name contains invalid characters");
		case EValidatorResult::AlreadyInUse:
			return TEXT("the name is already used in this blueprint");
		case EValidatorResult::EmptyName:
			return TEXT("the name is empty");
		default:
			return TEXT("the name is not a valid object name");
		}
	}

	FJsonObjectPtr HandleRename(const FJsonObject& Args)
	{
		const FString Operation = TEXT("rename");
		FJsonObjectPtr Result = MakeWidgetResult(Operation, nullptr);
		if (RefuseDuringPie(Result))
		{
			return Result;
		}
		FString Error;
		UWidgetBlueprint* Blueprint = ResolveWidgetBlueprint(Args, Error);
		if (!Blueprint)
		{
			return ErrorResult(Operation, Error);
		}
		Result->SetStringField(TEXT("asset_path"), Blueprint->GetPathName());
		UWidget* Widget = ResolveWidgetArg(Blueprint, Args, Error);
		if (!Widget)
		{
			return ErrorResult(Operation, Error, Blueprint);
		}
		const FString RequestedName = ReadStringAny(Args, { TEXT("new_name"), TEXT("name"), TEXT("display_name") });
		if (RequestedName.IsEmpty())
		{
			return ErrorResult(Operation, TEXT("new_name is required."), Blueprint);
		}
		const bool bRetargetBindings = ReadBoolAny(Args, { TEXT("retarget_bindings") }, true);
		const FName OldName = Widget->GetFName();
		const FName NewName = MakeObjectNameFromDisplayLabel(RequestedName, OldName);
		if (NewName == OldName)
		{
			Result->SetObjectField(TEXT("widget"), SerializeWidgetRecord(Blueprint, Widget));
			Result->SetBoolField(TEXT("unchanged"), true);
			return CompleteWidgetEdit(Blueprint, Args, Result, false);
		}
		if (UWidget* Existing = FindWidgetByName(Blueprint, NewName.ToString()))
		{
			return ErrorResult(Operation, FString::Printf(TEXT("A widget named '%s' already exists."), *NewName.ToString()), Blueprint);
		}
		const TSharedRef<FKismetNameValidator> NameValidator = MakeShareable(new FKismetNameValidator(Blueprint));
		const EValidatorResult ValidatorResult = NameValidator->IsValid(NewName);
		if (ValidatorResult != EValidatorResult::Ok)
		{
			return ErrorResult(Operation, FString::Printf(TEXT("Cannot rename '%s' to '%s': %s."), *OldName.ToString(), *NewName.ToString(), *ValidatorResultMessage(ValidatorResult)), Blueprint);
		}

		FWidgetBlueprintEditor* Editor = FindWidgetEditor(Blueprint, false);
		const FScopedTransaction Transaction(FText::FromString(TEXT("UEV: rename widget")));
		Blueprint->Modify();
		Blueprint->WidgetTree->Modify();
		Widget->Modify();

		if (Editor)
		{
			FWidgetReference Reference = Editor->GetReferenceFromTemplate(Widget);
			if (UWidget* PreviewWidget = Reference.GetPreview())
			{
				PreviewWidget->Modify();
				PreviewWidget->SetDisplayLabel(RequestedName);
				if (PreviewWidget == Widget)
				{
					Widget->Rename(*NewName.ToString(), Blueprint->WidgetTree, REN_ForceNoResetLoaders | REN_DontCreateRedirectors);
				}
				else
				{
					PreviewWidget->Rename(*NewName.ToString(), PreviewWidget->GetOuter(), REN_ForceNoResetLoaders | REN_DontCreateRedirectors);
					Widget->SetDisplayLabel(RequestedName);
					Widget->Rename(*NewName.ToString(), Blueprint->WidgetTree, REN_ForceNoResetLoaders | REN_DontCreateRedirectors);
				}
			}
			else
			{
				Widget->SetDisplayLabel(RequestedName);
				Widget->Rename(*NewName.ToString(), Blueprint->WidgetTree, REN_ForceNoResetLoaders | REN_DontCreateRedirectors);
			}
		}
		else
		{
			Widget->SetDisplayLabel(RequestedName);
			Widget->Rename(*NewName.ToString(), Blueprint->WidgetTree, REN_ForceNoResetLoaders | REN_DontCreateRedirectors);
		}

		int32 RetargetedBindings = 0;
		if (bRetargetBindings)
		{
			for (FDelegateEditorBinding& Binding : Blueprint->Bindings)
			{
				if (Binding.ObjectName == OldName.ToString())
				{
					Binding.ObjectName = NewName.ToString();
					++RetargetedBindings;
				}
			}
		}

		int32 RetargetedAnimationBindings = 0;
		for (UWidgetAnimation* Animation : Blueprint->Animations)
		{
			if (!Animation)
			{
				continue;
			}
			bool bAnimationChanged = false;
			for (FWidgetAnimationBinding& AnimationBinding : Animation->AnimationBindings)
			{
				if (AnimationBinding.WidgetName != OldName)
				{
					continue;
				}
				AnimationBinding.WidgetName = NewName;
				bAnimationChanged = true;
				++RetargetedAnimationBindings;
				if (Animation->MovieScene && AnimationBinding.SlotWidgetName == NAME_None)
				{
					if (FMovieScenePossessable* Possessable = Animation->MovieScene->FindPossessable(AnimationBinding.AnimationGuid))
					{
						Animation->MovieScene->Modify();
						Possessable->SetName(NewName.ToString());
					}
				}
			}
			if (bAnimationChanged)
			{
				Animation->Modify();
			}
		}

		const bool bVariableUsed = FBlueprintEditorUtils::IsVariableUsed(Blueprint, OldName);
		if (bRetargetBindings && (bVariableUsed || ReadBoolPropertyValue(Widget, TEXT("bIsVariable"))))
		{
			FBlueprintEditorUtils::ReplaceVariableReferences(Blueprint, OldName, NewName);
			AddWarning(Result, FString::Printf(TEXT("Variable references for '%s' were retargeted with ReplaceVariableReferences; verify bound variable pins in the graph."), *OldName.ToString()));
		}

		Result->SetObjectField(TEXT("widget"), SerializeWidgetRecord(Blueprint, Widget));
		Result->SetStringField(TEXT("previous_name"), OldName.ToString());
		Result->SetNumberField(TEXT("retargeted_bindings"), RetargetedBindings);
		Result->SetNumberField(TEXT("retargeted_animation_bindings"), RetargetedAnimationBindings);
		Result->SetBoolField(TEXT("retargeted_variables"), bVariableUsed);
		return CompleteWidgetEdit(Blueprint, Args, Result);
	}

	FJsonObjectPtr HandleRemoveSafe(const FJsonObject& Args)
	{
		const FString Operation = TEXT("remove_safe");
		FJsonObjectPtr Result = MakeWidgetResult(Operation, nullptr);
		if (RefuseDuringPie(Result))
		{
			return Result;
		}
		FString Error;
		UWidgetBlueprint* Blueprint = ResolveWidgetBlueprint(Args, Error);
		if (!Blueprint)
		{
			return ErrorResult(Operation, Error);
		}
		Result->SetStringField(TEXT("asset_path"), Blueprint->GetPathName());
		UWidget* Widget = ResolveWidgetArg(Blueprint, Args, Error);
		if (!Widget)
		{
			return ErrorResult(Operation, Error, Blueprint);
		}
		const bool bPurgeBindings = ReadBoolAny(Args, { TEXT("purge_bindings") }, true);
		const bool bPurgeAnimations = ReadBoolAny(Args, { TEXT("purge_animations") }, true);
		const bool bPurgeVariables = ReadBoolAny(Args, { TEXT("purge_variables") }, true);
		UWidgetTree* Tree = Blueprint->WidgetTree;
		UPanelWidget* Parent = Widget->GetParent();
		const FJsonObjectPtr RemovedRecord = SerializeWidgetRecord(Blueprint, Widget);
		const FString RemovedName = Widget->GetName();

		TArray<UWidget*> SubtreeWidgets;
		SubtreeWidgets.Add(Widget);
		UWidgetTree::GetChildWidgets(Widget, SubtreeWidgets);
		// GetChildWidgets includes the parent itself; deduplicate.
		TArray<UWidget*> Targets;
		for (UWidget* Candidate : SubtreeWidgets)
		{
			if (Candidate && !Targets.Contains(Candidate))
			{
				Targets.Add(Candidate);
			}
		}

		const FScopedTransaction Transaction(FText::FromString(TEXT("UEV: remove widget")));
		Tree->SetFlags(RF_Transactional);
		Tree->Modify();
		Blueprint->Modify();
		if (Parent)
		{
			Parent->SetFlags(RF_Transactional);
			Parent->Modify();
		}

		// Detach from the tree first so no slot keeps a reference to the removed subtree.
		Tree->RemoveWidget(Widget);
		if (!Parent)
		{
			TArray<UWidget*> AllWidgets;
			Tree->GetAllWidgets(AllWidgets);
			for (UWidget* Candidate : AllWidgets)
			{
				INamedSlotInterface* NamedSlotHost = Cast<INamedSlotInterface>(Candidate);
				if (!NamedSlotHost)
				{
					continue;
				}
				TArray<FName> SlotNames;
				NamedSlotHost->GetSlotNames(SlotNames);
				for (const FName& SlotName : SlotNames)
				{
					if (NamedSlotHost->GetContentForSlot(SlotName) == Widget)
					{
						NamedSlotHost->SetContentForSlot(SlotName, nullptr);
						AddWarning(Result, FString::Printf(TEXT("Removed named-slot content '%s' from slot '%s'."), *RemovedName, *SlotName.ToString()));
					}
				}
			}
		}

		int32 PurgedBindings = 0;
		int32 PurgedAnimationBindings = 0;
		int32 PurgedVariables = 0;
		TArray<TSharedPtr<FJsonValue>> RemovedNames;
		for (UWidget* Target : Targets)
		{
			if (!Target)
			{
				continue;
			}
			Target->SetFlags(RF_Transactional);
			Target->Modify();
			const FString TargetName = Target->GetName();
			RemovedNames.Add(MakeShared<FJsonValueString>(TargetName));

			if (bPurgeBindings)
			{
				const int32 Removed = Blueprint->Bindings.RemoveAll([&TargetName](const FDelegateEditorBinding& Binding)
				{
					return Binding.ObjectName == TargetName;
				});
				PurgedBindings += Removed;
			}

			if (bPurgeAnimations)
			{
				for (UWidgetAnimation* Animation : Blueprint->Animations)
				{
					if (!Animation)
					{
						continue;
					}
					TArray<FWidgetAnimationBinding>& AnimationBindings = Animation->AnimationBindings;
					for (int32 Index = AnimationBindings.Num() - 1; Index >= 0; --Index)
					{
						if (AnimationBindings[Index].WidgetName == Target->GetFName())
						{
							const FGuid Guid = AnimationBindings[Index].AnimationGuid;
							if (Animation->MovieScene)
							{
								Animation->MovieScene->Modify();
								Animation->MovieScene->RemovePossessable(Guid);
							}
							AnimationBindings.RemoveAt(Index);
							++PurgedAnimationBindings;
						}
					}
					Animation->Modify();
				}
			}

			if (bPurgeVariables && FBlueprintEditorUtils::IsVariableUsed(Blueprint, Target->GetFName()))
			{
				FBlueprintEditorUtils::RemoveVariableNodes(Blueprint, Target->GetFName());
				++PurgedVariables;
			}

			Target->Rename(nullptr, GetTransientPackage(), REN_DoNotDirty | REN_DontCreateRedirectors);
		}

		if (Parent)
		{
			// keep Parent alive in the undo record
			Parent->Modify();
		}
		FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);

		Result->SetObjectField(TEXT("widget"), RemovedRecord);
		Result->SetStringField(TEXT("removed_widget"), RemovedName);
		Result->SetStringField(TEXT("parent"), Parent ? Parent->GetName() : FString());
		Result->SetNumberField(TEXT("removed_count"), Targets.Num());
		Result->SetNumberField(TEXT("purged_bindings"), PurgedBindings);
		Result->SetNumberField(TEXT("purged_animation_bindings"), PurgedAnimationBindings);
		Result->SetNumberField(TEXT("purged_variable_nodes"), PurgedVariables);
		Result->SetArrayField(TEXT("removed_widgets"), RemovedNames);
		return CompleteWidgetEdit(Blueprint, Args, Result);
	}
}

namespace
{
	FJsonObjectPtr HandleReparent(const FJsonObject& Args)
	{
		const FString Operation = TEXT("reparent");
		FJsonObjectPtr Result = MakeWidgetResult(Operation, nullptr);
		if (RefuseDuringPie(Result))
		{
			return Result;
		}
		FString Error;
		UWidgetBlueprint* Blueprint = ResolveWidgetBlueprint(Args, Error);
		if (!Blueprint)
		{
			return ErrorResult(Operation, Error);
		}
		Result->SetStringField(TEXT("asset_path"), Blueprint->GetPathName());
		UWidget* Widget = ResolveWidgetArg(Blueprint, Args, Error);
		if (!Widget)
		{
			return ErrorResult(Operation, Error, Blueprint);
		}
		UPanelWidget* NewParent = ResolveParentArg(Blueprint, Args, Error);
		if (!NewParent)
		{
			return ErrorResult(Operation, Error.IsEmpty() ? TEXT("parent is required for reparent.") : Error, Blueprint);
		}
		for (UWidget* Ancestor = NewParent; Ancestor; Ancestor = Ancestor->GetParent())
		{
			if (Ancestor == Widget)
			{
				return ErrorResult(Operation, FString::Printf(TEXT("Cannot reparent '%s' into itself or one of its own descendants."), *Widget->GetName()), Blueprint);
			}
		}
		UWidgetTree* Tree = Blueprint->WidgetTree;
		UPanelWidget* OldParent = Widget->GetParent();
		const int32 OldIndex = OldParent ? OldParent->GetChildIndex(Widget) : 0;
		const FString OldSlotClass = Widget->Slot ? Widget->Slot->GetClass()->GetName() : FString();
		const bool bKeepLayout = ReadBoolAny(Args, { TEXT("keep_layout") }, true);
		FAnchorData SavedLayout;
		int32 SavedZOrder = 0;
		bool bHasCanvasLayout = false;
		if (UCanvasPanelSlot* OldCanvas = Cast<UCanvasPanelSlot>(Widget->Slot))
		{
			SavedLayout = OldCanvas->LayoutData;
			SavedZOrder = OldCanvas->ZOrder;
			bHasCanvasLayout = true;
		}
		const int32 RequestedIndex = ReadIndexArg(Args, INDEX_NONE);

		const FScopedTransaction Transaction(FText::FromString(TEXT("UEV: reparent widget")));
		Tree->SetFlags(RF_Transactional);
		Tree->Modify();
		Blueprint->Modify();
		Widget->SetFlags(RF_Transactional);
		Widget->Modify();
		if (OldParent)
		{
			OldParent->Modify();
		}
		NewParent->Modify();

		Tree->RemoveWidget(Widget);
		const int32 TargetIndex = RequestedIndex == INDEX_NONE ? NewParent->GetChildrenCount() : FMath::Clamp(RequestedIndex, 0, NewParent->GetChildrenCount());
		if (!NewParent->InsertChildAt(TargetIndex, Widget))
		{
			return ErrorResult(Operation, FString::Printf(TEXT("Parent '%s' rejected the reparent."), *NewParent->GetName()), Blueprint);
		}
		bool bLayoutKept = false;
		if (bKeepLayout && bHasCanvasLayout)
		{
			if (UCanvasPanelSlot* NewCanvas = Cast<UCanvasPanelSlot>(Widget->Slot))
			{
				NewCanvas->Modify();
				NewCanvas->LayoutData = SavedLayout;
				NewCanvas->ZOrder = SavedZOrder;
				bLayoutKept = true;
			}
		}
		if (FWidgetBlueprintEditor* Editor = FindWidgetEditor(Blueprint, false))
		{
			Widget->SetDesignerFlags(Editor->GetCurrentDesignerFlags());
		}
		const FString NewSlotClass = Widget->Slot ? Widget->Slot->GetClass()->GetName() : FString();
		Result->SetObjectField(TEXT("widget"), SerializeWidgetRecord(Blueprint, Widget));
		Result->SetStringField(TEXT("previous_parent"), OldParent ? OldParent->GetName() : FString());
		Result->SetStringField(TEXT("parent"), NewParent->GetName());
		Result->SetNumberField(TEXT("previous_index"), OldIndex);
		Result->SetNumberField(TEXT("index"), NewParent->GetChildIndex(Widget));
		Result->SetStringField(TEXT("previous_slot_class"), OldSlotClass);
		Result->SetStringField(TEXT("slot_class"), NewSlotClass);
		Result->SetBoolField(TEXT("slot_class_changed"), OldSlotClass != NewSlotClass);
		Result->SetBoolField(TEXT("kept_layout"), bLayoutKept);
		if (!bLayoutKept && bHasCanvasLayout && bKeepLayout)
		{
			AddWarning(Result, FString::Printf(TEXT("Canvas layout could not be preserved because the new slot is %s."), NewSlotClass.IsEmpty() ? TEXT("missing") : *NewSlotClass));
		}
		return CompleteWidgetEdit(Blueprint, Args, Result);
	}

	FJsonObjectPtr SerializeTreeWidget(UWidgetBlueprint* Blueprint, UWidget* Widget, bool bIncludeSlot)
	{
		FJsonObjectPtr Node = SerializeWidgetRecord(Blueprint, Widget);
		if (!bIncludeSlot)
		{
			Node->RemoveField(TEXT("slot"));
		}
		TArray<TSharedPtr<FJsonValue>> Children;
		if (UPanelWidget* Panel = Cast<UPanelWidget>(Widget))
		{
			const int32 ChildCount = Panel->GetChildrenCount();
			for (int32 Index = 0; Index < ChildCount; ++Index)
			{
				if (UWidget* Child = Panel->GetChildAt(Index))
				{
					Children.Add(MakeShared<FJsonValueObject>(SerializeTreeWidget(Blueprint, Child, bIncludeSlot)));
				}
			}
		}
		Node->SetArrayField(TEXT("children"), Children);
		return Node;
	}

	FJsonObjectPtr HandleSerializeTree(const FJsonObject& Args)
	{
		const FString Operation = TEXT("serialize_tree");
		FJsonObjectPtr Result = MakeWidgetResult(Operation, nullptr);
		FString Error;
		UWidgetBlueprint* Blueprint = ResolveWidgetBlueprint(Args, Error);
		if (!Blueprint)
		{
			return ErrorResult(Operation, Error);
		}
		Result->SetStringField(TEXT("asset_path"), Blueprint->GetPathName());
		const bool bIncludeSlot = ReadBoolAny(Args, { TEXT("include_slot"), TEXT("include_slots") }, true);
		UWidgetTree* Tree = Blueprint->WidgetTree;
		TArray<TSharedPtr<FJsonValue>> Widgets;
		int32 WidgetCount = 0;
		if (Tree->RootWidget)
		{
			Tree->ForEachWidget([&](UWidget* Widget)
			{
				Widgets.Add(MakeShared<FJsonValueObject>(SerializeWidgetRecord(Blueprint, Widget)));
				++WidgetCount;
			});
		}
		Result->SetStringField(TEXT("root_widget"), Tree->RootWidget ? Tree->RootWidget->GetName() : FString());
		Result->SetNumberField(TEXT("widget_count"), WidgetCount);
		Result->SetArrayField(TEXT("widgets"), Widgets);
		if (Tree->RootWidget)
		{
			Result->SetObjectField(TEXT("tree"), SerializeTreeWidget(Blueprint, Tree->RootWidget, bIncludeSlot));
		}
		Result->SetNumberField(TEXT("binding_count"), Blueprint->Bindings.Num());
		Result->SetNumberField(TEXT("animation_count"), Blueprint->Animations.Num());
		return Result;
	}

	void ScanContainerForMissingAssets(UStruct* Struct, void* Container, const FString& Context, int32 Depth, TSet<FString>& Seen, TArray<TSharedPtr<FJsonValue>>& Out);

	void ScanPropertyForMissingAssets(FProperty* Property, void* ValuePtr, const FString& Context, int32 Depth, TSet<FString>& Seen, TArray<TSharedPtr<FJsonValue>>& Out)
	{
		if (!Property || !ValuePtr || Depth > 3)
		{
			return;
		}
		if (FSoftObjectProperty* SoftProperty = CastField<FSoftObjectProperty>(Property))
		{
			const FSoftObjectPtr* SoftValue = static_cast<const FSoftObjectPtr*>(ValuePtr);
			if (SoftValue->IsNull())
			{
				return;
			}
			const FString AssetPath = SoftValue->ToSoftObjectPath().ToString();
			if (Seen.Contains(AssetPath))
			{
				return;
			}
			Seen.Add(AssetPath);
			if (!SoftValue->IsValid() && !SoftValue->LoadSynchronous())
			{
				FJsonObjectPtr Entry = UEVGraph::MakeObject();
				Entry->SetStringField(TEXT("path"), AssetPath);
				Entry->SetStringField(TEXT("property"), SoftProperty->GetName());
				Entry->SetStringField(TEXT("context"), Context);
				Entry->SetStringField(TEXT("owner"), SoftProperty->GetOwnerClass() ? SoftProperty->GetOwnerClass()->GetName() : FString());
				Out.Add(MakeShared<FJsonValueObject>(Entry));
			}
		}
		else if (FStructProperty* StructProperty = CastField<FStructProperty>(Property))
		{
			ScanContainerForMissingAssets(StructProperty->Struct, ValuePtr, Context + TEXT(".") + Property->GetName(), Depth + 1, Seen, Out);
		}
		else if (FArrayProperty* ArrayProperty = CastField<FArrayProperty>(Property))
		{
			if (CastField<FStructProperty>(ArrayProperty->Inner))
			{
				FScriptArrayHelper Helper(ArrayProperty, ValuePtr);
				for (int32 Index = 0; Index < Helper.Num(); ++Index)
				{
					ScanPropertyForMissingAssets(ArrayProperty->Inner, Helper.GetRawPtr(Index), Context + TEXT(".") + Property->GetName(), Depth + 1, Seen, Out);
				}
			}
		}
	}

	void ScanContainerForMissingAssets(UStruct* Struct, void* Container, const FString& Context, int32 Depth, TSet<FString>& Seen, TArray<TSharedPtr<FJsonValue>>& Out)
	{
		if (!Struct || !Container || Depth > 3)
		{
			return;
		}
		for (TFieldIterator<FProperty> It(Struct); It; ++It)
		{
			FProperty* Property = *It;
			if (Property->HasAnyPropertyFlags(CPF_Transient | CPF_DuplicateTransient))
			{
				continue;
			}
			ScanPropertyForMissingAssets(Property, Property->ContainerPtrToValuePtr<void>(Container), Context, Depth, Seen, Out);
		}
	}

	FJsonObjectPtr HandleValidate(const FJsonObject& Args)
	{
		const FString Operation = TEXT("validate");
		FJsonObjectPtr Result = MakeWidgetResult(Operation, nullptr);
		FString Error;
		UWidgetBlueprint* Blueprint = ResolveWidgetBlueprint(Args, Error);
		if (!Blueprint)
		{
			return ErrorResult(Operation, Error);
		}
		Result->SetStringField(TEXT("asset_path"), Blueprint->GetPathName());
		UWidgetTree* Tree = Blueprint->WidgetTree;
		TArray<TSharedPtr<FJsonValue>> OrphanBindings;
		TArray<TSharedPtr<FJsonValue>> DuplicateNames;
		TArray<TSharedPtr<FJsonValue>> Unreachable;
		TArray<TSharedPtr<FJsonValue>> MissingAssets;
		TArray<TSharedPtr<FJsonValue>> AnimationIssues;
		TSet<UWidget*> Reachable;
		TMap<FString, int32> NameCounts;
		if (Tree->RootWidget)
		{
			Tree->ForEachWidget([&](UWidget* Widget)
			{
				Reachable.Add(Widget);
				NameCounts.FindOrAdd(Widget->GetName())++;
			});
		}
		for (const auto& Pair : NameCounts)
		{
			if (Pair.Value > 1)
			{
				FJsonObjectPtr Entry = UEVGraph::MakeObject();
				Entry->SetStringField(TEXT("name"), Pair.Key);
				Entry->SetNumberField(TEXT("count"), Pair.Value);
				DuplicateNames.Add(MakeShared<FJsonValueObject>(Entry));
			}
		}

		for (const FDelegateEditorBinding& Binding : Blueprint->Bindings)
		{
			UWidget* Target = Tree->FindWidget(FName(*Binding.ObjectName));
			const bool bHasWidget = Target != nullptr;
			const bool bHasProperty = bHasWidget && Target->GetClass()->FindPropertyByName(Binding.PropertyName) != nullptr;
			const bool bIsFunction = Binding.Kind == EBindingKind::Function;
			const bool bHasFunction = !bIsFunction || UEVGraph::FindGraphByName(Blueprint, Binding.FunctionName.ToString()) != nullptr;
			if (!bHasWidget || !bHasProperty || !bHasFunction)
			{
				FJsonObjectPtr Entry = UEVGraph::MakeObject();
				Entry->SetStringField(TEXT("object_name"), Binding.ObjectName);
				Entry->SetStringField(TEXT("property_name"), Binding.PropertyName.ToString());
				Entry->SetStringField(TEXT("function_name"), Binding.FunctionName.ToString());
				Entry->SetBoolField(TEXT("widget_exists"), bHasWidget);
				Entry->SetBoolField(TEXT("property_exists"), bHasProperty);
				Entry->SetBoolField(TEXT("function_exists"), bHasFunction);
				OrphanBindings.Add(MakeShared<FJsonValueObject>(Entry));
			}
		}

		for (UWidgetAnimation* Animation : Blueprint->Animations)
		{
			if (!Animation)
			{
				continue;
			}
			for (const FWidgetAnimationBinding& AnimationBinding : Animation->AnimationBindings)
			{
				if (!Tree->FindWidget(AnimationBinding.WidgetName))
				{
					FJsonObjectPtr Entry = UEVGraph::MakeObject();
					Entry->SetStringField(TEXT("animation"), Animation->GetName());
					Entry->SetStringField(TEXT("widget_name"), AnimationBinding.WidgetName.ToString());
					Entry->SetStringField(TEXT("animation_guid"), AnimationBinding.AnimationGuid.ToString());
					AnimationIssues.Add(MakeShared<FJsonValueObject>(Entry));
				}
			}
		}

		for (TObjectIterator<UWidget> It; It; ++It)
		{
			UWidget* Candidate = *It;
			if (!Candidate || Candidate->HasAnyFlags(RF_ClassDefaultObject) || Candidate->IsPendingKill())
			{
				continue;
			}
			if (Candidate->GetOuter() != Tree || Reachable.Contains(Candidate))
			{
				continue;
			}
			FJsonObjectPtr Entry = UEVGraph::MakeObject();
			Entry->SetStringField(TEXT("name"), Candidate->GetName());
			Entry->SetStringField(TEXT("class"), Candidate->GetClass()->GetName());
			Unreachable.Add(MakeShared<FJsonValueObject>(Entry));
		}

		TSet<FString> SeenAssetPaths;
		TArray<UWidget*> AllWidgets;
		if (Tree->RootWidget)
		{
			Tree->GetAllWidgets(AllWidgets);
		}
		for (UWidget* Widget : AllWidgets)
		{
			ScanContainerForMissingAssets(Widget->GetClass(), Widget, Widget->GetName(), 0, SeenAssetPaths, MissingAssets);
		}

		const bool bHasRoot = Tree->RootWidget != nullptr;
		const int32 IssueCount = OrphanBindings.Num() + DuplicateNames.Num() + Unreachable.Num() + MissingAssets.Num() + AnimationIssues.Num() + (bHasRoot ? 0 : 1);
		Result->SetBoolField(TEXT("valid"), IssueCount == 0);
		Result->SetNumberField(TEXT("issue_count"), IssueCount);
		Result->SetBoolField(TEXT("has_root"), bHasRoot);
		Result->SetNumberField(TEXT("widget_count"), Reachable.Num());
		Result->SetNumberField(TEXT("binding_count"), Blueprint->Bindings.Num());
		Result->SetArrayField(TEXT("orphan_bindings"), OrphanBindings);
		Result->SetArrayField(TEXT("duplicate_names"), DuplicateNames);
		Result->SetArrayField(TEXT("unreachable"), Unreachable);
		Result->SetArrayField(TEXT("missing_assets"), MissingAssets);
		Result->SetArrayField(TEXT("orphan_animation_bindings"), AnimationIssues);
		if (!bHasRoot)
		{
			AddWarning(Result, TEXT("The widget tree has no root widget."));
		}
		return Result;
	}

	FJsonObjectPtr CloneJsonObject(const FJsonObject& Source)
	{
		FJsonObjectPtr Copy = UEVGraph::MakeObject();
		for (const auto& Pair : Source.Values)
		{
			Copy->SetField(Pair.Key, Pair.Value);
		}
		return Copy;
	}

	FJsonObjectPtr MakeSlateColorStruct(const FLinearColor& Color)
	{
		FJsonObjectPtr Object = UEVGraph::MakeObject();
		Object->SetObjectField(TEXT("specifiedColor"), MakeLinearColorStruct(Color));
		return Object;
	}

	int32 PatchBrush(const FJsonObjectPtr& Result, UObject* Target, const FString& BrushPath, const TSharedPtr<FJsonObject>& Spec, const FString& Label)
	{
		if (!Target || !Spec.IsValid())
		{
			return 0;
		}
		int32 Applied = 0;
		const FString ResourcePath = ReadStringAny(*Spec, { TEXT("texture_path"), TEXT("texture"), TEXT("resource_path"), TEXT("asset_path") });
		const FString MaterialPath = ReadStringAny(*Spec, { TEXT("material_path"), TEXT("material") });
		UObject* LoadedResource = nullptr;
		if (!ResourcePath.IsEmpty())
		{
			LoadedResource = LoadObject<UObject>(nullptr, *ResourcePath);
			if (!LoadedResource)
			{
				AddWarning(Result, FString::Printf(TEXT("%s.texture_path could not be loaded: %s"), *Label, *ResourcePath));
			}
			else if (TrySetPath(Result, Target, BrushPath + TEXT(".ResourceObject"), MakeShared<FJsonValueString>(ResourcePath), Label + TEXT(".texture")))
			{
				++Applied;
			}
		}
		else if (!MaterialPath.IsEmpty())
		{
			LoadedResource = LoadObject<UObject>(nullptr, *MaterialPath);
			if (!LoadedResource)
			{
				AddWarning(Result, FString::Printf(TEXT("%s.material_path could not be loaded: %s"), *Label, *MaterialPath));
			}
			else if (TrySetPath(Result, Target, BrushPath + TEXT(".ResourceObject"), MakeShared<FJsonValueString>(MaterialPath), Label + TEXT(".material")))
			{
				++Applied;
			}
		}
		const FString DrawAs = ReadStringAny(*Spec, { TEXT("draw_as"), TEXT("draw_type") });
		if (!DrawAs.IsEmpty() && TrySetPath(Result, Target, BrushPath + TEXT(".DrawAs"), MakeShared<FJsonValueString>(DrawAs), Label + TEXT(".draw_as")))
		{
			++Applied;
		}
		const FJsonValuePtr MarginValue = ReadValueAny(*Spec, { TEXT("margin") });
		FMargin Margin;
		if (ReadMargin(MarginValue, Margin) && TrySetPath(Result, Target, BrushPath + TEXT(".Margin"), MakeShared<FJsonValueObject>(MakeMarginStruct(Margin)), Label + TEXT(".margin")))
		{
			++Applied;
		}
		const FJsonValuePtr TintValue = ReadValueAny(*Spec, { TEXT("tint"), TEXT("tint_color"), TEXT("color") });
		FLinearColor Tint;
		if (ReadLinearColor(TintValue, Tint) && TrySetPath(Result, Target, BrushPath + TEXT(".TintColor"), MakeShared<FJsonValueObject>(MakeSlateColorStruct(Tint)), Label + TEXT(".tint")))
		{
			++Applied;
		}
		const FJsonValuePtr ImageSizeValue = ReadValueAny(*Spec, { TEXT("image_size") });
		FVector2D ImageSize;
		if (ReadVector2(ImageSizeValue, ImageSize) && TrySetPath(Result, Target, BrushPath + TEXT(".ImageSize"), MakeShared<FJsonValueObject>(MakeVector2Struct(ImageSize)), Label + TEXT(".image_size")))
		{
			++Applied;
		}
		if (ReadBoolAny(*Spec, { TEXT("match_size") }, false) && LoadedResource && LoadedResource->IsA<UTexture>())
		{
			UTexture* Texture = static_cast<UTexture*>(LoadedResource);
			if (TrySetPath(Result, Target, BrushPath + TEXT(".ImageSize"), MakeShared<FJsonValueObject>(MakeVector2Struct(FVector2D(Texture->GetSurfaceWidth(), Texture->GetSurfaceHeight()))), Label + TEXT(".match_size")))
			{
				++Applied;
			}
		}
		return Applied;
	}

	FString ExportPropertyText(UObject* Object, FProperty* Property)
	{
		if (!Object || !Property)
		{
			return FString();
		}
		FString Text;
		Property->ExportTextItem(Text, Property->ContainerPtrToValuePtr<void>(Object), nullptr, Object, PPF_None);
		return Text;
	}

	TSharedPtr<FJsonObject> ReadStyleSnapshot(UObject* Widget)
	{
		TSharedPtr<FJsonObject> Snapshot = UEVGraph::MakeObject();
		if (!Widget)
		{
			return Snapshot;
		}
		UClass* WidgetClass = Widget->GetClass();
		if (FProperty* FontProperty = FindStructPropertyOfType(WidgetClass, FSlateFontInfo::StaticStruct(), TEXT("Font")))
		{
			Snapshot->SetStringField(TEXT("font"), ExportPropertyText(Widget, FontProperty));
		}
		if (FProperty* StyleProperty = FindStructPropertyOfType(WidgetClass, FButtonStyle::StaticStruct(), TEXT("Style")))
		{
			Snapshot->SetStringField(TEXT("button_style"), ExportPropertyText(Widget, StyleProperty));
		}
		for (const FString& BrushName : { TEXT("Brush"), TEXT("Background"), TEXT("ForegroundImage") })
		{
			if (FProperty* BrushProperty = FindPropertyOfClass(WidgetClass, { BrushName }))
			{
				Snapshot->SetStringField(BrushName.ToLower(), ExportPropertyText(Widget, BrushProperty));
			}
		}
		for (const FString& ColorName : { TEXT("ColorAndOpacity"), TEXT("ForegroundColor"), TEXT("Color"), TEXT("BrushColor") })
		{
			if (FProperty* ColorProperty = FindPropertyOfClass(WidgetClass, { ColorName }))
			{
				Snapshot->SetStringField(ColorName.ToLower(), ExportPropertyText(Widget, ColorProperty));
			}
		}
		return Snapshot;
	}

	FJsonObjectPtr HandleSetBrush(const FJsonObject& Args)
	{
		const FString Operation = TEXT("set_brush");
		FJsonObjectPtr Result = MakeWidgetResult(Operation, nullptr);
		if (RefuseDuringPie(Result))
		{
			return Result;
		}
		FString Error;
		UWidgetBlueprint* Blueprint = ResolveWidgetBlueprint(Args, Error);
		if (!Blueprint)
		{
			return ErrorResult(Operation, Error);
		}
		Result->SetStringField(TEXT("asset_path"), Blueprint->GetPathName());
		UWidget* Widget = ResolveWidgetArg(Blueprint, Args, Error);
		if (!Widget)
		{
			return ErrorResult(Operation, Error, Blueprint);
		}
		const TSharedPtr<FJsonObject> BrushSpec = UEVGraph::GetObject(Args, TEXT("brush"));
		const TSharedPtr<FJsonObject> Spec = BrushSpec.IsValid() ? BrushSpec : CloneJsonObject(Args);
		FString PropertyPath = ReadStringAny(Args, { TEXT("property"), TEXT("property_path"), TEXT("brush_property") });
		if (PropertyPath.IsEmpty())
		{
			FProperty* Property = FindPropertyOfClass(Widget->GetClass(), { TEXT("Brush"), TEXT("Background"), TEXT("ForegroundImage") });
			PropertyPath = Property ? Property->GetName() : TEXT("Brush");
		}

		const FScopedTransaction Transaction(FText::FromString(TEXT("UEV: set brush")));
		Blueprint->Modify();
		Widget->Modify();
		const int32 Applied = PatchBrush(Result, Widget, PropertyPath, Spec, TEXT("brush"));
		if (Applied == 0)
		{
			AddWarning(Result, FString::Printf(TEXT("No brush fields were applied to %s on %s."), *PropertyPath, *Widget->GetName()));
		}
		Result->SetObjectField(TEXT("widget"), SerializeWidgetRecord(Blueprint, Widget));
		Result->SetStringField(TEXT("property"), PropertyPath);
		Result->SetNumberField(TEXT("applied_fields"), Applied);
		Result->SetObjectField(TEXT("read_back"), ReadStyleSnapshot(Widget));
		return CompleteWidgetEdit(Blueprint, Args, Result);
	}

	FJsonObjectPtr HandleSetStyle(const FJsonObject& Args)
	{
		const FString Operation = TEXT("set_style");
		FJsonObjectPtr Result = MakeWidgetResult(Operation, nullptr);
		if (RefuseDuringPie(Result))
		{
			return Result;
		}
		FString Error;
		UWidgetBlueprint* Blueprint = ResolveWidgetBlueprint(Args, Error);
		if (!Blueprint)
		{
			return ErrorResult(Operation, Error);
		}
		Result->SetStringField(TEXT("asset_path"), Blueprint->GetPathName());
		UWidget* Widget = ResolveWidgetArg(Blueprint, Args, Error);
		if (!Widget)
		{
			return ErrorResult(Operation, Error, Blueprint);
		}
		const TSharedPtr<FJsonObject> Style = UEVGraph::GetObject(Args, TEXT("style"));
		const TSharedPtr<FJsonObject> StyleObject = Style.IsValid() ? Style : CloneJsonObject(Args);

		const FScopedTransaction Transaction(FText::FromString(TEXT("UEV: set style")));
		Blueprint->Modify();
		Widget->Modify();
		TArray<TSharedPtr<FJsonValue>> Applied;
		auto NoteApplied = [&Applied](const FString& Name)
		{
			Applied.Add(MakeShared<FJsonValueString>(Name));
		};

		const TSharedPtr<FJsonObject> FontSpec = UEVGraph::GetObject(*StyleObject, TEXT("font"));
		const bool bHasFlatFont = StyleObject->HasField(TEXT("font_size")) || StyleObject->HasField(TEXT("font_family"));
		if (FontSpec.IsValid() || bHasFlatFont)
		{
			FStructProperty* FontProperty = FindStructPropertyOfType(Widget->GetClass(), FSlateFontInfo::StaticStruct(), TEXT("Font"));
			if (!FontProperty)
			{
				AddWarning(Result, FString::Printf(TEXT("%s has no font struct property."), *Widget->GetClass()->GetName()));
			}
			else
			{
				FSlateFontInfo* Font = FontProperty->ContainerPtrToValuePtr<FSlateFontInfo>(Widget);
				const TSharedPtr<FJsonObject> FontValues = FontSpec.IsValid() ? FontSpec : StyleObject;
				const FString FontPath = ReadStringAny(*FontValues, { TEXT("family_asset"), TEXT("font_asset"), TEXT("font_object"), TEXT("family") });
				if (!FontPath.IsEmpty())
				{
					if (UObject* FontObject = LoadObject<UObject>(nullptr, *FontPath))
					{
						Font->FontObject = FontObject;
						NoteApplied(TEXT("font.family"));
					}
					else
					{
						AddWarning(Result, FString::Printf(TEXT("font.family could not be loaded: %s"), *FontPath));
					}
				}
				const double FontSize = ReadNumberAny(*FontValues, { TEXT("size"), TEXT("font_size") }, 0.0);
				if (FontSize > 0.0)
				{
					Font->Size = FMath::Clamp(static_cast<int32>(FontSize), 1, 400);
					NoteApplied(TEXT("font.size"));
				}
				const FString Typeface = ReadStringAny(*FontValues, { TEXT("typeface"), TEXT("typeface_font_name") });
				if (!Typeface.IsEmpty())
				{
					Font->TypefaceFontName = FName(*Typeface);
					NoteApplied(TEXT("font.typeface"));
				}
				const double LetterSpacing = ReadNumberAny(*FontValues, { TEXT("letter_spacing") }, 0.0);
				if (LetterSpacing != 0.0)
				{
					Font->LetterSpacing = static_cast<int32>(LetterSpacing);
					NoteApplied(TEXT("font.letter_spacing"));
				}
				const double OutlineSize = ReadNumberAny(*FontValues, { TEXT("outline_size") }, -1.0);
				if (OutlineSize >= 0.0)
				{
					Font->OutlineSettings.OutlineSize = FMath::Clamp(static_cast<int32>(OutlineSize), 0, 32);
					NoteApplied(TEXT("font.outline_size"));
				}
				FLinearColor OutlineColor;
				if (ReadLinearColor(ReadValueAny(*FontValues, { TEXT("outline_color") }), OutlineColor))
				{
					Font->OutlineSettings.OutlineColor = OutlineColor;
					NoteApplied(TEXT("font.outline_color"));
				}
				Widget->Modify();
			}
		}

		FLinearColor FlatColor;
		if (ReadLinearColor(ReadValueAny(*StyleObject, { TEXT("text_color"), TEXT("tint") }), FlatColor))
		{
			FStructProperty* ColorProperty = FindStructPropertyOfType(Widget->GetClass(), FSlateColor::StaticStruct(), TEXT("ColorAndOpacity"));
			if (ColorProperty && TrySetPath(Result, Widget, ColorProperty->GetName() + TEXT(".SpecifiedColor"), MakeShared<FJsonValueObject>(MakeLinearColorStruct(FlatColor)), TEXT("text_color")))
			{
				NoteApplied(TEXT("text_color"));
			}
		}

		const TSharedPtr<FJsonObject> ColorSpec = UEVGraph::GetObject(*StyleObject, TEXT("color"));
		const TSharedPtr<FJsonObject> ColorAndOpacitySpec = UEVGraph::GetObject(*StyleObject, TEXT("color_and_opacity"));
		const TSharedPtr<FJsonObject> ForegroundSpec = UEVGraph::GetObject(*StyleObject, TEXT("foreground_color"));
		if (ColorAndOpacitySpec.IsValid())
		{
			FLinearColor Color;
			if (ReadLinearColor(MakeShared<FJsonValueObject>(ColorAndOpacitySpec), Color) && TrySetPath(Result, Widget, TEXT("ColorAndOpacity.SpecifiedColor"), MakeShared<FJsonValueObject>(MakeLinearColorStruct(Color)), TEXT("color_and_opacity")))
			{
				NoteApplied(TEXT("color_and_opacity"));
			}
		}
		if (ForegroundSpec.IsValid())
		{
			FLinearColor Color;
			if (ReadLinearColor(MakeShared<FJsonValueObject>(ForegroundSpec), Color) && TrySetPath(Result, Widget, TEXT("ForegroundColor.SpecifiedColor"), MakeShared<FJsonValueObject>(MakeLinearColorStruct(Color)), TEXT("foreground_color")))
			{
				NoteApplied(TEXT("foreground_color"));
			}
		}
		if (ColorSpec.IsValid())
		{
			FLinearColor Color;
			FStructProperty* ColorProperty = FindStructPropertyOfType(Widget->GetClass(), FSlateColor::StaticStruct(), TEXT("Color"));
			if (ReadLinearColor(MakeShared<FJsonValueObject>(ColorSpec), Color) && ColorProperty && TrySetPath(Result, Widget, ColorProperty->GetName() + TEXT(".SpecifiedColor"), MakeShared<FJsonValueObject>(MakeLinearColorStruct(Color)), TEXT("color")))
			{
				NoteApplied(TEXT("color"));
			}
		}

		const TSharedPtr<FJsonObject> BrushSpec = UEVGraph::GetObject(*StyleObject, TEXT("brush"));
		const TSharedPtr<FJsonObject> StatesSpec = UEVGraph::GetObject(*StyleObject, TEXT("states"));
		if (BrushSpec.IsValid())
		{
			FProperty* BrushProperty = FindPropertyOfClass(Widget->GetClass(), { TEXT("Brush"), TEXT("Background") });
			const FString BrushPath = BrushProperty ? BrushProperty->GetName() : TEXT("Brush");
			if (PatchBrush(Result, Widget, BrushPath, BrushSpec, BrushPath) > 0)
			{
				NoteApplied(TEXT("brush"));
			}
		}
		if (StatesSpec.IsValid())
		{
			FStructProperty* ButtonStyleProperty = FindStructPropertyOfType(Widget->GetClass(), FButtonStyle::StaticStruct(), TEXT("Style"));
			if (!ButtonStyleProperty)
			{
				AddWarning(Result, FString::Printf(TEXT("%s has no FButtonStyle property; states were ignored."), *Widget->GetClass()->GetName()));
			}
			else
			{
				const FString StylePath = ButtonStyleProperty->GetName();
				for (const FString& StateName : { TEXT("normal"), TEXT("hovered"), TEXT("pressed"), TEXT("disabled") })
				{
					const TSharedPtr<FJsonObject> StateSpec = UEVGraph::GetObject(*StatesSpec, StateName);
					if (!StateSpec.IsValid())
					{
						continue;
					}
					const FString SlotName = StateName == TEXT("normal") ? TEXT("Normal") : (StateName == TEXT("hovered") ? TEXT("Hovered") : (StateName == TEXT("pressed") ? TEXT("Pressed") : TEXT("Disabled")));
					if (PatchBrush(Result, Widget, StylePath + TEXT(".") + SlotName, StateSpec, StateName) > 0)
					{
						NoteApplied(FString::Printf(TEXT("states.%s"), *StateName));
					}
				}
			}
		}

		if (Applied.Num() == 0)
		{
			AddWarning(Result, FString::Printf(TEXT("No style fields were applied to %s."), *Widget->GetName()));
		}
		Result->SetObjectField(TEXT("widget"), SerializeWidgetRecord(Blueprint, Widget));
		Result->SetArrayField(TEXT("applied"), Applied);
		Result->SetNumberField(TEXT("applied_count"), Applied.Num());
		Result->SetObjectField(TEXT("read_back"), ReadStyleSnapshot(Widget));
		return CompleteWidgetEdit(Blueprint, Args, Result);
	}
	FJsonObjectPtr HandleListDelegates(const FJsonObject& Args)
	{
		const FString Operation = TEXT("list_delegates");
		FJsonObjectPtr Result = MakeWidgetResult(Operation, nullptr);
		FString Error;
		UWidgetBlueprint* Blueprint = ResolveWidgetBlueprint(Args, Error);
		if (!Blueprint)
		{
			return ErrorResult(Operation, Error);
		}
		Result->SetStringField(TEXT("asset_path"), Blueprint->GetPathName());
		UWidget* Widget = ResolveWidgetArg(Blueprint, Args, Error);
		UClass* TargetClass = nullptr;
		if (Widget)
		{
			TargetClass = Widget->GetClass();
		}
		else
		{
			const FString ClassName = ReadStringAny(Args, { TEXT("class"), TEXT("widget_class") });
			if (!ClassName.IsEmpty())
			{
				TargetClass = ResolveWidgetClass(ClassName, Error);
			}
		}
		if (!TargetClass)
		{
			return ErrorResult(Operation, Error.IsEmpty() ? TEXT("Provide widget or class to list delegates.") : Error, Blueprint);
		}

		TArray<TSharedPtr<FJsonValue>> Delegates;
		for (TFieldIterator<FMulticastDelegateProperty> It(TargetClass); It; ++It)
		{
			FMulticastDelegateProperty* Property = *It;
			FJsonObjectPtr Entry = UEVGraph::MakeObject();
			Entry->SetStringField(TEXT("name"), Property->GetName());
			Entry->SetStringField(TEXT("signature"), Property->SignatureFunction ? Property->SignatureFunction->GetName() : Property->GetCPPType(nullptr, 0));
			Entry->SetStringField(TEXT("declared_in"), Property->GetOwnerClass() ? Property->GetOwnerClass()->GetName() : FString());
			TArray<TSharedPtr<FJsonValue>> Bound;
			if (Widget)
			{
				for (const FDelegateEditorBinding& Binding : Blueprint->Bindings)
				{
					if (Binding.ObjectName == Widget->GetName() && Binding.PropertyName == Property->GetFName())
					{
						Bound.Add(MakeShared<FJsonValueString>(Binding.FunctionName.ToString()));
					}
				}
			}
			Entry->SetArrayField(TEXT("bound_functions"), Bound);
			Delegates.Add(MakeShared<FJsonValueObject>(Entry));
		}

		TArray<TSharedPtr<FJsonValue>> GraphFunctions;
		for (UEdGraph* Graph : Blueprint->FunctionGraphs)
		{
			if (Graph)
			{
				GraphFunctions.Add(MakeShared<FJsonValueString>(Graph->GetName()));
			}
		}
		Result->SetStringField(TEXT("class"), TargetClass->GetName());
		Result->SetStringField(TEXT("widget"), Widget ? Widget->GetName() : FString());
		Result->SetNumberField(TEXT("delegate_count"), Delegates.Num());
		Result->SetArrayField(TEXT("delegates"), Delegates);
		Result->SetArrayField(TEXT("function_graphs"), GraphFunctions);
		return Result;
	}

	FJsonObjectPtr HandleListBoundEvents(const FJsonObject& Args)
	{
		const FString Operation = TEXT("list_bound_events");
		FJsonObjectPtr Result = MakeWidgetResult(Operation, nullptr);
		FString Error;
		UWidgetBlueprint* Blueprint = ResolveWidgetBlueprint(Args, Error);
		if (!Blueprint)
		{
			return ErrorResult(Operation, Error);
		}
		Result->SetStringField(TEXT("asset_path"), Blueprint->GetPathName());
		UWidgetTree* Tree = Blueprint->WidgetTree;
		const FString FilterWidget = ResolveWidgetNameArg(Args);
		TArray<TSharedPtr<FJsonValue>> Bindings;
		int32 OrphanCount = 0;
		for (const FDelegateEditorBinding& Binding : Blueprint->Bindings)
		{
			if (!FilterWidget.IsEmpty() && Binding.ObjectName != FilterWidget)
			{
				continue;
			}
			UWidget* Target = Tree->FindWidget(FName(*Binding.ObjectName));
			const bool bHasProperty = Target && Target->GetClass()->FindPropertyByName(Binding.PropertyName) != nullptr;
			const bool bIsFunction = Binding.Kind == EBindingKind::Function;
			const bool bHasFunction = !bIsFunction || UEVGraph::FindGraphByName(Blueprint, Binding.FunctionName.ToString()) != nullptr;
			const bool bValid = Target && bHasProperty && bHasFunction;
			if (!bValid)
			{
				++OrphanCount;
			}
			FJsonObjectPtr Entry = UEVGraph::MakeObject();
			Entry->SetStringField(TEXT("object_name"), Binding.ObjectName);
			Entry->SetStringField(TEXT("widget_id"), Target ? BuildWidgetId(Blueprint, Target) : FString());
			Entry->SetStringField(TEXT("property_name"), Binding.PropertyName.ToString());
			Entry->SetStringField(TEXT("function_name"), Binding.FunctionName.ToString());
			Entry->SetStringField(TEXT("kind"), bIsFunction ? TEXT("function") : TEXT("property"));
			Entry->SetStringField(TEXT("source_property"), Binding.SourceProperty.ToString());
			Entry->SetBoolField(TEXT("widget_exists"), Target != nullptr);
			Entry->SetBoolField(TEXT("property_exists"), bHasProperty);
			Entry->SetBoolField(TEXT("function_exists"), bHasFunction);
			Entry->SetBoolField(TEXT("valid"), bValid);
			Bindings.Add(MakeShared<FJsonValueObject>(Entry));
		}
		Result->SetNumberField(TEXT("binding_count"), Bindings.Num());
		Result->SetNumberField(TEXT("orphan_count"), OrphanCount);
		Result->SetArrayField(TEXT("bindings"), Bindings);
		return Result;
	}

	FJsonObjectPtr HandleUnbindEvent(const FJsonObject& Args)
	{
		const FString Operation = TEXT("unbind_event");
		FJsonObjectPtr Result = MakeWidgetResult(Operation, nullptr);
		if (RefuseDuringPie(Result))
		{
			return Result;
		}
		FString Error;
		UWidgetBlueprint* Blueprint = ResolveWidgetBlueprint(Args, Error);
		if (!Blueprint)
		{
			return ErrorResult(Operation, Error);
		}
		Result->SetStringField(TEXT("asset_path"), Blueprint->GetPathName());
		UWidget* Widget = ResolveWidgetArg(Blueprint, Args, Error);
		if (!Widget)
		{
			return ErrorResult(Operation, Error, Blueprint);
		}
		const FString PropertyName = ReadStringAny(Args, { TEXT("event"), TEXT("event_name"), TEXT("property_name"), TEXT("delegate") });
		if (PropertyName.IsEmpty())
		{
			return ErrorResult(Operation, TEXT("event (or property_name) is required."), Blueprint);
		}
		const FString FunctionFilter = ReadStringAny(Args, { TEXT("function"), TEXT("function_name") });
		const bool bRemoveFunctionGraph = ReadBoolAny(Args, { TEXT("remove_function_graph") }, false);

		const FScopedTransaction Transaction(FText::FromString(TEXT("UEV: unbind event")));
		Blueprint->Modify();
		TArray<TSharedPtr<FJsonValue>> Removed;
		const int32 RemovedCount = Blueprint->Bindings.RemoveAll([&](const FDelegateEditorBinding& Binding)
		{
			if (Binding.ObjectName != Widget->GetName() || Binding.PropertyName.ToString() != PropertyName)
			{
				return false;
			}
			if (!FunctionFilter.IsEmpty() && Binding.FunctionName.ToString() != FunctionFilter)
			{
				return false;
			}
			FJsonObjectPtr Entry = UEVGraph::MakeObject();
			Entry->SetStringField(TEXT("object_name"), Binding.ObjectName);
			Entry->SetStringField(TEXT("property_name"), Binding.PropertyName.ToString());
			Entry->SetStringField(TEXT("function_name"), Binding.FunctionName.ToString());
			Removed.Add(MakeShared<FJsonValueObject>(Entry));
			return true;
		});

		if (RemovedCount == 0)
		{
			Result->SetNumberField(TEXT("removed_count"), 0);
			Result->SetArrayField(TEXT("removed"), Removed);
			AddWarning(Result, FString::Printf(TEXT("No binding matched %s.%s."), *Widget->GetName(), *PropertyName));
			return Result;
		}
		FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);

		TArray<TSharedPtr<FJsonValue>> RemovedGraphs;
		if (bRemoveFunctionGraph && !FunctionFilter.IsEmpty())
		{
			const bool bStillBound = Blueprint->Bindings.ContainsByPredicate([&](const FDelegateEditorBinding& Binding)
			{
				return Binding.FunctionName.ToString() == FunctionFilter;
			});
			if (!bStillBound)
			{
				if (UEdGraph* Graph = UEVGraph::FindGraphByName(Blueprint, FunctionFilter))
				{
					FBlueprintEditorUtils::RemoveGraph(Blueprint, Graph, EGraphRemoveFlags::Recompile);
					RemovedGraphs.Add(MakeShared<FJsonValueString>(FunctionFilter));
				}
			}
			else
			{
				AddWarning(Result, FString::Printf(TEXT("Function graph '%s' is still bound to another event; it was kept."), *FunctionFilter));
			}
		}
		Result->SetNumberField(TEXT("removed_count"), RemovedCount);
		Result->SetArrayField(TEXT("removed"), Removed);
		Result->SetArrayField(TEXT("removed_function_graphs"), RemovedGraphs);
		return CompleteWidgetEdit(Blueprint, Args, Result);
	}

	FJsonObjectPtr HandleScreenshot(const FJsonObject& Args)
	{
		const FString Operation = TEXT("screenshot");
		FJsonObjectPtr Result = MakeWidgetResult(Operation, nullptr);
		if (RefuseDuringPie(Result))
		{
			return Result;
		}
		FString Error;
		UWidgetBlueprint* Blueprint = ResolveWidgetBlueprint(Args, Error);
		if (!Blueprint)
		{
			return ErrorResult(Operation, Error);
		}
		Result->SetStringField(TEXT("asset_path"), Blueprint->GetPathName());
		const int32 Width = FMath::Clamp(static_cast<int32>(ReadNumberAny(Args, { TEXT("width") }, 1280.0)), 64, 4096);
		const int32 Height = FMath::Clamp(static_cast<int32>(ReadNumberAny(Args, { TEXT("height") }, 720.0)), 64, 4096);
		if (!FSlateApplication::IsInitialized())
		{
			return ErrorResult(Operation, TEXT("Slate is not initialized; the designer cannot be rendered in this session."), Blueprint);
		}
		FWidgetBlueprintEditor* Editor = FindWidgetEditor(Blueprint, true);
		if (!Editor)
		{
			return ErrorResult(Operation, TEXT("The widget blueprint editor is not available; open the asset in the designer and retry."), Blueprint);
		}
		Editor->RefreshPreview();
		UUserWidget* Preview = Editor->GetPreview();
		if (!Preview)
		{
			return ErrorResult(Operation, TEXT("The designer preview is not available (it may be invalid after a structural change; retry once the designer refreshes)."), Blueprint);
		}
		const int32 Generation = GetStructuralVersion(Blueprint);
		TSharedPtr<SWidget> PreviewSlate = Preview->TakeWidget();
		if (!PreviewSlate.IsValid())
		{
			return ErrorResult(Operation, TEXT("The designer preview produced no Slate widget."), Blueprint);
		}
		const FVector2D DrawSize(static_cast<float>(Width), static_cast<float>(Height));
		FWidgetRenderer Renderer(false, true);
		UTextureRenderTarget2D* Target = Renderer.DrawWidget(PreviewSlate.ToSharedRef(), DrawSize);
		if (!Target)
		{
			return ErrorResult(Operation, TEXT("FWidgetRenderer failed to draw the designer preview."), Blueprint);
		}
		FlushRenderingCommands();
		FTextureRenderTargetResource* Resource = Target->GameThread_GetRenderTargetResource();
		if (!Resource)
		{
			return ErrorResult(Operation, TEXT("The render target has no resource."), Blueprint);
		}
		TArray<FColor> Pixels;
		if (!Resource->ReadPixels(Pixels) || Pixels.Num() < Width * Height)
		{
			return ErrorResult(Operation, FString::Printf(TEXT("ReadPixels failed (read %d of %d pixels)."), Pixels.Num(), Width * Height), Blueprint);
		}
		Pixels.SetNum(Width * Height);
		TArray<uint8> PngData;
		FImageUtils::CompressImageArray(Width, Height, Pixels, PngData);
		if (PngData.Num() == 0)
		{
			return ErrorResult(Operation, TEXT("PNG compression produced no data."), Blueprint);
		}
		FString FilePath = ReadStringAny(Args, { TEXT("output_path"), TEXT("path"), TEXT("png_path") });
		if (FilePath.IsEmpty())
		{
			FilePath = FPaths::ConvertRelativePathToFull(FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UEV"), TEXT("Screenshots"), FString::Printf(TEXT("%s_%s_%03d.png"), *Blueprint->GetName(), *FDateTime::Now().ToString(TEXT("%Y%m%d_%H%M%S")), FDateTime::Now().GetMillisecond())));
		}
		else
		{
			FilePath = FPaths::ConvertRelativePathToFull(FilePath);
		}
		const FString ProjectDir = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir());
		if (!FPaths::ConvertRelativePathToFull(FilePath).StartsWith(ProjectDir))
		{
			return ErrorResult(Operation, TEXT("output_path must stay inside the project directory."), Blueprint);
		}
		IFileManager::Get().MakeDirectory(*FPaths::GetPath(FilePath), true);
		if (!FFileHelper::SaveArrayToFile(PngData, *FilePath))
		{
			return ErrorResult(Operation, FString::Printf(TEXT("Could not write the PNG to %s."), *FilePath), Blueprint);
		}
		GCapturedVersions.Add(Blueprint, Generation);
		const int32 CurrentGeneration = GetStructuralVersion(Blueprint);
		Result->SetStringField(TEXT("png_path"), FilePath);
		Result->SetNumberField(TEXT("width"), Width);
		Result->SetNumberField(TEXT("height"), Height);
		Result->SetNumberField(TEXT("bytes"), PngData.Num());
		Result->SetNumberField(TEXT("preview_generation"), Generation);
		Result->SetNumberField(TEXT("current_generation"), CurrentGeneration);
		Result->SetBoolField(TEXT("preview_stale"), Generation != CurrentGeneration);
		Result->SetBoolField(TEXT("preview_invalidated"), true);
		Result->SetStringField(TEXT("preview_root"), Preview->GetClass()->GetName());
		if (Generation != CurrentGeneration)
		{
			AddWarning(Result, TEXT("The widget tree changed while the preview was rendered; capture again for a matching image."));
		}
		return Result;
	}

	FJsonObjectPtr HandleInspectSelection(const FJsonObject& Args)
	{
		const FString Operation = TEXT("inspect_selection");
		FJsonObjectPtr Result = MakeWidgetResult(Operation, nullptr);
		FString Error;
		UWidgetBlueprint* Blueprint = ResolveWidgetBlueprint(Args, Error);
		if (!Blueprint)
		{
			return ErrorResult(Operation, Error);
		}
		Result->SetStringField(TEXT("asset_path"), Blueprint->GetPathName());
		FWidgetBlueprintEditor* Editor = FindWidgetEditor(Blueprint, false);
		TArray<TSharedPtr<FJsonValue>> Selected;
		if (Editor)
		{
			for (const FWidgetReference& Reference : Editor->GetSelectedWidgets())
			{
				UWidget* Template = Reference.GetTemplate();
				if (!Template)
				{
					continue;
				}
				FJsonObjectPtr Entry = SerializeWidgetRecord(Blueprint, Template);
				UWidget* PreviewWidget = Reference.GetPreview();
				Entry->SetStringField(TEXT("preview_name"), PreviewWidget ? PreviewWidget->GetName() : FString());
				Entry->SetBoolField(TEXT("reference_valid"), Reference.IsValid());
				Selected.Add(MakeShared<FJsonValueObject>(Entry));
			}
		}
		Result->SetBoolField(TEXT("editor_open"), Editor != nullptr);
		Result->SetNumberField(TEXT("selected_count"), Selected.Num());
		Result->SetArrayField(TEXT("selected"), Selected);
		if (!Editor)
		{
			AddWarning(Result, TEXT("The widget blueprint editor is not open; selection cannot be read."));
		}
		Result->SetNumberField(TEXT("preview_generation"), GetStructuralVersion(Blueprint));
		return Result;
	}
}

UEVGraph::FJsonObjectPtr UEVGraph::HandleWidgetOperation(const FString& Operation, const FJsonObject& Args)
{
	const FString Name = Operation.ToLower();
	if (Name == TEXT("insert_child")) { return HandleInsertChild(Args); }
	if (Name == TEXT("reorder_child")) { return HandleReorderChild(Args); }
	if (Name == TEXT("duplicate")) { return HandleDuplicate(Args); }
	if (Name == TEXT("rename")) { return HandleRename(Args); }
	if (Name == TEXT("remove_safe")) { return HandleRemoveSafe(Args); }
	if (Name == TEXT("reparent")) { return HandleReparent(Args); }
	if (Name == TEXT("serialize_tree")) { return HandleSerializeTree(Args); }
	if (Name == TEXT("validate")) { return HandleValidate(Args); }
	if (Name == TEXT("set_style")) { return HandleSetStyle(Args); }
	if (Name == TEXT("set_brush")) { return HandleSetBrush(Args); }
	if (Name == TEXT("list_delegates")) { return HandleListDelegates(Args); }
	if (Name == TEXT("list_bound_events")) { return HandleListBoundEvents(Args); }
	if (Name == TEXT("unbind_event")) { return HandleUnbindEvent(Args); }
	if (Name == TEXT("screenshot")) { return HandleScreenshot(Args); }
	if (Name == TEXT("inspect_selection")) { return HandleInspectSelection(Args); }
	return UEVGraph::MakeErrorObject(FString::Printf(TEXT("Unknown widget operation: %s"), *Operation));
}