#include "UEVGraphShared.h"

#include "AnimationBlueprintLibrary.h"
#include "Animation/AnimCurveTypes.h"
#include "Animation/AnimInstance.h"
#include "Animation/AnimNotifies/AnimNotify.h"
#include "Animation/AnimNotifies/AnimNotifyState.h"
#include "Animation/AnimSequenceBase.h"
#include "AssetRegistryModule.h"
#include "Animation/Skeleton.h"
#include "Engine/SkeletalMesh.h"
#include "AssetToolsModule.h"
#include "Factories/AnimBlueprintFactory.h"
#include "Factories/AnimMontageFactory.h"
#include "IAssetTools.h"
#include "Kismet2/KismetEditorUtilities.h"

namespace UEVGraph
{
	namespace
	{
		FString AnimationAssetName(const FJsonObject& Args)
		{
			FString Name = GetString(Args, TEXT("asset_name"));
			if (Name.IsEmpty()) Name = GetString(Args, TEXT("name"));
			return Name;
		}

		FString AnimationPackagePath(const FJsonObject& Args)
		{
			FString Path = GetString(Args, TEXT("path"), TEXT("/Game/UEV/Generated"));
			return Path.StartsWith(TEXT("/")) ? Path : TEXT("/Game/") + Path;
		}

		FJsonObjectPtr SerializeNotify(const FAnimNotifyEvent& Event)
		{
			FJsonObjectPtr Result = MakeObject();
			Result->SetStringField(TEXT("name"), Event.NotifyName.ToString());
			Result->SetStringField(TEXT("class"), Event.Notify ? Event.Notify->GetClass()->GetName()
				: (Event.NotifyStateClass ? Event.NotifyStateClass->GetClass()->GetName() : FString()));
			Result->SetNumberField(TEXT("time"), Event.GetTriggerTime());
			Result->SetNumberField(TEXT("duration"), Event.GetDuration());
			return Result;
		}

		FSlotAnimationTrack* FindSlot(UAnimMontage* Montage, const FString& SlotName)
		{
			if (!Montage)
			{
				return nullptr;
			}
			for (FSlotAnimationTrack& Slot : Montage->SlotAnimTracks)
			{
				if (Slot.SlotName.ToString().Equals(SlotName, ESearchCase::IgnoreCase))
				{
					return &Slot;
				}
			}
			return nullptr;
		}

		FSlotAnimationTrack& EnsureSlot(UAnimMontage* Montage, const FString& SlotName)
		{
			if (FSlotAnimationTrack* Existing = FindSlot(Montage, SlotName))
			{
				return *Existing;
			}
			return Montage->AddSlot(FName(*SlotName));
		}

		FCompositeSection* FindSection(UAnimMontage* Montage, const FString& SectionName, int32 Index)
		{
			if (!Montage)
			{
				return nullptr;
			}
			if (!SectionName.IsEmpty())
			{
				for (FCompositeSection& Section : Montage->CompositeSections)
				{
					if (Section.SectionName.ToString().Equals(SectionName, ESearchCase::IgnoreCase))
					{
						return &Section;
					}
				}
				return nullptr;
			}
			return Montage->CompositeSections.IsValidIndex(Index) ? &Montage->CompositeSections[Index] : nullptr;
		}

		FAnimSegment MakeSegment(UAnimSequenceBase* Sequence, float StartPos, float StartTime, float EndTime, float Rate, int32 Loops)
		{
			FAnimSegment Segment;
			Segment.AnimReference = Sequence;
			Segment.StartPos = StartPos;
			Segment.AnimStartTime = StartTime;
			Segment.AnimEndTime = EndTime > 0.f ? EndTime : (Sequence ? Sequence->SequenceLength : 0.f);
			Segment.AnimPlayRate = Rate;
			Segment.LoopingCount = Loops;
			return Segment;
		}

		FJsonObjectPtr SerializeMontage(UAnimMontage* Montage)
		{
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetStringField(TEXT("asset_path"), Montage->GetPathName());
			Result->SetNumberField(TEXT("length"), Montage->CalculateSequenceLength());
			Result->SetNumberField(TEXT("rate_scale"), Montage->RateScale);
			Result->SetNumberField(TEXT("blend_in"), Montage->BlendIn.GetBlendTime());
			Result->SetNumberField(TEXT("blend_out"), Montage->BlendOut.GetBlendTime());
			Result->SetNumberField(TEXT("blend_out_trigger"), Montage->BlendOutTriggerTime);
			Result->SetBoolField(TEXT("auto_blend_out"), Montage->bEnableAutoBlendOut);
			Result->SetStringField(TEXT("sync_group"), Montage->SyncGroup.ToString());

			TArray<TSharedPtr<FJsonValue>> Sections;
			for (int32 Index = 0; Index < Montage->CompositeSections.Num(); ++Index)
			{
				const FCompositeSection& Section = Montage->CompositeSections[Index];
				float Start = 0.f;
				float End = 0.f;
				Montage->GetSectionStartAndEndTime(Index, Start, End);
				FJsonObjectPtr SectionObject = MakeObject();
				SectionObject->SetStringField(TEXT("name"), Section.SectionName.ToString());
				SectionObject->SetStringField(TEXT("next"), Section.NextSectionName.ToString());
				SectionObject->SetNumberField(TEXT("start"), Start);
				SectionObject->SetNumberField(TEXT("end"), End);
				Sections.Add(MakeShared<FJsonValueObject>(SectionObject));
			}
			Result->SetArrayField(TEXT("sections"), Sections);

			TArray<TSharedPtr<FJsonValue>> Slots;
			for (const FSlotAnimationTrack& Slot : Montage->SlotAnimTracks)
			{
				FJsonObjectPtr SlotObject = MakeObject();
				SlotObject->SetStringField(TEXT("name"), Slot.SlotName.ToString());
				TArray<TSharedPtr<FJsonValue>> Segments;
				for (const FAnimSegment& Segment : Slot.AnimTrack.AnimSegments)
				{
					FJsonObjectPtr SegmentObject = MakeObject();
					SegmentObject->SetStringField(TEXT("animation"), Segment.AnimReference ? Segment.AnimReference->GetPathName() : FString());
					SegmentObject->SetNumberField(TEXT("start_pos"), Segment.StartPos);
					SegmentObject->SetNumberField(TEXT("start_time"), Segment.AnimStartTime);
					SegmentObject->SetNumberField(TEXT("end_time"), Segment.AnimEndTime);
					SegmentObject->SetNumberField(TEXT("play_rate"), Segment.AnimPlayRate);
					SegmentObject->SetNumberField(TEXT("loops"), Segment.LoopingCount);
					Segments.Add(MakeShared<FJsonValueObject>(SegmentObject));
				}
				SlotObject->SetArrayField(TEXT("segments"), Segments);
				Slots.Add(MakeShared<FJsonValueObject>(SlotObject));
			}
			Result->SetArrayField(TEXT("slots"), Slots);

			TArray<TSharedPtr<FJsonValue>> Notifies;
			for (const FAnimNotifyEvent& Notify : Montage->Notifies)
			{
				Notifies.Add(MakeShared<FJsonValueObject>(SerializeNotify(Notify)));
			}
			Result->SetArrayField(TEXT("notifies"), Notifies);
			return Result;
		}
	}

	FJsonObjectPtr HandleAnimationOperationInternal(const FString& Operation, const FJsonObject& Args)
	{
		if (Operation == TEXT("inspect_graph") || Operation == TEXT("inspect_node_properties")
			|| Operation == TEXT("add_graph_node") || Operation == TEXT("set_node_property")
			|| Operation == TEXT("connect_nodes") || Operation == TEXT("disconnect_nodes") || Operation == TEXT("delete_node")
			|| Operation == TEXT("add_state_machine") || Operation == TEXT("add_state") || Operation == TEXT("add_conduit")
			|| Operation == TEXT("add_transition") || Operation == TEXT("set_transition") || Operation == TEXT("set_state_properties")
			|| Operation == TEXT("rename_state") || Operation == TEXT("remove_state") || Operation == TEXT("remove_transition")
			|| Operation == TEXT("add_rule_node"))
		{
			return HandleAnimationGraphOperation(Operation, Args);
		}

		FString Error;
		if (Operation == TEXT("search_animation_assets"))
		{
			const FString Search = GetString(Args, TEXT("search_term")).ToLower();
			const int32 Limit = FMath::Max(1, static_cast<int32>(GetNumber(Args, TEXT("limit"), 100.0)));
			FAssetRegistryModule& Registry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry");
			TArray<TSharedPtr<FJsonValue>> Assets;
			for (UClass* Class : { UAnimSequence::StaticClass(), UAnimMontage::StaticClass(), UAnimBlueprint::StaticClass() })
			{
				TArray<FAssetData> Found;
				Registry.Get().GetAssetsByClass(Class->GetFName(), Found, true);
				for (const FAssetData& Asset : Found)
				{
					const FString Path = Asset.PackageName.ToString();
					if (!Search.IsEmpty() && !Path.ToLower().Contains(Search) && !Asset.AssetName.ToString().ToLower().Contains(Search))
					{
						continue;
					}
					FJsonObjectPtr Entry = MakeObject();
					Entry->SetStringField(TEXT("name"), Asset.AssetName.ToString());
					Entry->SetStringField(TEXT("path"), Path);
					Entry->SetStringField(TEXT("class"), Asset.AssetClass.ToString());
					Assets.Add(MakeShared<FJsonValueObject>(Entry));
					if (Assets.Num() >= Limit)
					{
						break;
					}
				}
			}
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetArrayField(TEXT("assets"), Assets);
			return Result;
		}

		if (Operation == TEXT("create_anim_blueprint"))
		{
			const FString Name = AnimationAssetName(Args);
			const FString SkeletonPath = GetString(Args, TEXT("skeleton"));
			USkeleton* Skeleton = Cast<USkeleton>(LoadAsset(SkeletonPath, USkeleton::StaticClass(), Error));
			if (!Skeleton || Name.IsEmpty())
			{
				return MakeErrorObject(Error.IsEmpty() ? TEXT("name and skeleton are required.") : Error);
			}
			UAnimBlueprintFactory* Factory = NewObject<UAnimBlueprintFactory>();
			Factory->TargetSkeleton = Skeleton;
			Factory->ParentClass = UAnimInstance::StaticClass();
			const FString PreviewMesh = GetString(Args, TEXT("preview_mesh"));
			if (!PreviewMesh.IsEmpty())
			{
				Factory->PreviewSkeletalMesh = Cast<USkeletalMesh>(LoadAsset(PreviewMesh, USkeletalMesh::StaticClass(), Error));
			}
			IAssetTools& AssetTools = FModuleManager::LoadModuleChecked<FAssetToolsModule>("AssetTools").Get();
			UObject* Asset = AssetTools.CreateAsset(Name, AnimationPackagePath(Args), UAnimBlueprint::StaticClass(), Factory);
			if (!Asset)
			{
				return MakeErrorObject(TEXT("Could not create AnimBlueprint."));
			}
			Asset->GetOutermost()->MarkPackageDirty();
			SaveAsset(Asset, Error);
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetStringField(TEXT("asset_path"), Asset->GetPathName());
			return Result;
		}

		if (Operation == TEXT("inspect_sequence"))
		{
			UAnimSequence* Sequence = LoadAnimSequence(Args, Error);
			if (!Sequence)
			{
				return MakeErrorObject(Error);
			}
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetStringField(TEXT("asset_path"), Sequence->GetPathName());
			Result->SetNumberField(TEXT("length"), Sequence->SequenceLength);
			Result->SetNumberField(TEXT("rate_scale"), Sequence->RateScale);
			Result->SetBoolField(TEXT("root_motion"), UAnimationBlueprintLibrary::IsRootMotionEnabled(Sequence));

			TArray<FAnimNotifyEvent> NotifyEvents;
			UAnimationBlueprintLibrary::GetAnimationNotifyEvents(Sequence, NotifyEvents);
			TArray<TSharedPtr<FJsonValue>> Notifies;
			for (const FAnimNotifyEvent& Notify : NotifyEvents) Notifies.Add(MakeShared<FJsonValueObject>(SerializeNotify(Notify)));
			Result->SetArrayField(TEXT("notifies"), Notifies);

			TArray<FName> NotifyTracks;
			UAnimationBlueprintLibrary::GetAnimationNotifyTrackNames(Sequence, NotifyTracks);
			TArray<TSharedPtr<FJsonValue>> TrackValues;
			for (const FName& Track : NotifyTracks) TrackValues.Add(MakeShared<FJsonValueString>(Track.ToString()));
			Result->SetArrayField(TEXT("notify_tracks"), TrackValues);

			TArray<FAnimSyncMarker> Markers;
			UAnimationBlueprintLibrary::GetAnimationSyncMarkers(Sequence, Markers);
			TArray<TSharedPtr<FJsonValue>> MarkerValues;
			for (const FAnimSyncMarker& Marker : Markers)
			{
				FJsonObjectPtr MarkerObject = MakeObject();
				MarkerObject->SetStringField(TEXT("name"), Marker.MarkerName.ToString());
				MarkerObject->SetNumberField(TEXT("time"), Marker.Time);
				MarkerValues.Add(MakeShared<FJsonValueObject>(MarkerObject));
			}
			Result->SetArrayField(TEXT("sync_markers"), MarkerValues);

			TArray<FName> CurveNames;
			UAnimationBlueprintLibrary::GetAnimationCurveNames(Sequence, ERawCurveTrackTypes::RCT_Float, CurveNames);
			TArray<TSharedPtr<FJsonValue>> CurveValues;
			for (const FName& Curve : CurveNames) CurveValues.Add(MakeShared<FJsonValueString>(Curve.ToString()));
			Result->SetArrayField(TEXT("curves"), CurveValues);
			return Result;
		}

		if (Operation == TEXT("set_sequence_properties"))
		{
			UAnimSequence* Sequence = LoadAnimSequence(Args, Error);
			if (!Sequence)
			{
				return MakeErrorObject(Error);
			}
			if (Args.HasField(TEXT("rate_scale"))) Sequence->RateScale = static_cast<float>(GetNumber(Args, TEXT("rate_scale")));
			if (Args.HasField(TEXT("root_motion"))) UAnimationBlueprintLibrary::SetRootMotionEnabled(Sequence, GetBool(Args, TEXT("root_motion")));
			const TSharedPtr<FJsonObject> Properties = GetObject(Args, TEXT("properties"));
			if (Properties.IsValid())
			{
				for (const auto& Pair : Properties->Values)
				{
					if (!SetObjectPropertyPath(Sequence, Pair.Key, Pair.Value, Error))
					{
						return MakeErrorObject(Error);
					}
				}
			}
			Sequence->GetOutermost()->MarkPackageDirty();
			if (GetBool(Args, TEXT("save"), false)) SaveAsset(Sequence, Error);
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetNumberField(TEXT("rate_scale"), Sequence->RateScale);
			return Result;
		}

		if (Operation == TEXT("add_notify") || Operation == TEXT("add_montage_notify"))
		{
			const bool bMontage = Operation == TEXT("add_montage_notify") || !GetString(Args, TEXT("montage_path")).IsEmpty();
			UAnimSequenceBase* Base = bMontage ? static_cast<UAnimSequenceBase*>(LoadAnimMontage(Args, Error))
				: static_cast<UAnimSequenceBase*>(LoadAnimSequence(Args, Error));
			if (!Base)
			{
				return MakeErrorObject(Error);
			}
			Base->Modify();
			const FName TrackName(*GetString(Args, TEXT("track_name"), TEXT("Default")));
			const float Time = static_cast<float>(GetNumber(Args, TEXT("time"), 0.0));
			const float Duration = static_cast<float>(GetNumber(Args, TEXT("duration"), 0.0));
			const FString ClassPath = GetString(Args, TEXT("notify_class"), TEXT("AnimNotify"));
			UClass* NotifyClass = ResolveClass(ClassPath, UAnimNotify::StaticClass(), Error);
			if (!NotifyClass)
			{
				return MakeErrorObject(Error);
			}
			if (!bMontage)
			{
				UAnimSequence* Sequence = Cast<UAnimSequence>(Base);
				if (Duration > 0.f)
				{
					UClass* StateClass = ResolveClass(GetString(Args, TEXT("notify_state_class"), TEXT("AnimNotifyState")), UAnimNotifyState::StaticClass(), Error);
					if (!StateClass) return MakeErrorObject(Error);
					UAnimationBlueprintLibrary::AddAnimationNotifyStateEvent(Sequence, TrackName, Time, Duration, StateClass);
				}
				else
				{
					UAnimationBlueprintLibrary::AddAnimationNotifyEvent(Sequence, TrackName, Time, NotifyClass);
				}
			}
			else
			{
				UAnimMontage* Montage = Cast<UAnimMontage>(Base);
				FAnimNotifyEvent Event;
				Event.NotifyName = FName(*GetString(Args, TEXT("notify_name"), NotifyClass->GetName()));
				Event.Link(Montage, Time, 0);
				if (Duration > 0.f)
				{
					UClass* StateClass = ResolveClass(GetString(Args, TEXT("notify_state_class"), TEXT("AnimNotifyState")), UAnimNotifyState::StaticClass(), Error);
					if (!StateClass) return MakeErrorObject(Error);
					Event.NotifyStateClass = NewObject<UAnimNotifyState>(Montage, StateClass, NAME_None, RF_Transactional);
					Event.Duration = Duration;
					Event.EndLink.Link(Montage, Time + Duration, 0);
				}
				else
				{
					Event.Notify = NewObject<UAnimNotify>(Montage, NotifyClass, NAME_None, RF_Transactional);
				}
				Montage->Notifies.Add(Event);
				Montage->SortNotifies();
			}
			Base->GetOutermost()->MarkPackageDirty();
			if (GetBool(Args, TEXT("save"), false)) SaveAsset(Base, Error);
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetStringField(TEXT("asset_path"), Base->GetPathName());
			return Result;
		}

		if (Operation == TEXT("remove_notify"))
		{
			UAnimSequence* Sequence = LoadAnimSequence(Args, Error);
			if (!Sequence)
			{
				return MakeErrorObject(Error);
			}
			UAnimationBlueprintLibrary::RemoveAnimationNotifyEventsByName(
				Sequence,
				FName(*GetString(Args, TEXT("notify_name"))));
			Sequence->GetOutermost()->MarkPackageDirty();
			if (GetBool(Args, TEXT("save"), false)) SaveAsset(Sequence, Error);
			return MakeSuccess();
		}

		if (Operation == TEXT("add_notify_track") || Operation == TEXT("remove_notify_track")
			|| Operation == TEXT("add_sync_marker") || Operation == TEXT("remove_sync_marker")
			|| Operation == TEXT("add_curve_key") || Operation == TEXT("remove_curve"))
		{
			UAnimSequence* Sequence = LoadAnimSequence(Args, Error);
			if (!Sequence)
			{
				return MakeErrorObject(Error);
			}
			Sequence->Modify();
			if (Operation == TEXT("add_notify_track"))
			{
				UAnimationBlueprintLibrary::AddAnimationNotifyTrack(Sequence, FName(*GetString(Args, TEXT("track_name"), TEXT("Default"))));
			}
			else if (Operation == TEXT("remove_notify_track"))
			{
				UAnimationBlueprintLibrary::RemoveAnimationNotifyTrack(Sequence, FName(*GetString(Args, TEXT("track_name"), TEXT("Default"))));
			}
			else if (Operation == TEXT("add_sync_marker"))
			{
				UAnimationBlueprintLibrary::AddAnimationSyncMarker(
					Sequence,
					FName(*GetString(Args, TEXT("marker_name"), TEXT("Marker"))),
					static_cast<float>(GetNumber(Args, TEXT("time"), 0.0)),
					FName(*GetString(Args, TEXT("track_name"), TEXT("Default"))));
			}
			else if (Operation == TEXT("remove_sync_marker"))
			{
				UAnimationBlueprintLibrary::RemoveAnimationSyncMarkersByName(Sequence, FName(*GetString(Args, TEXT("marker_name"), TEXT("Marker"))));
			}
			else if (Operation == TEXT("add_curve_key"))
			{
				const FName CurveName(*GetString(Args, TEXT("curve_name"), TEXT("Curve")));
				Sequence->Modify();
				UAnimationBlueprintLibrary::AddCurve(Sequence, CurveName, ERawCurveTrackTypes::RCT_Float);
				UAnimationBlueprintLibrary::AddFloatCurveKey(
					Sequence,
					CurveName,
					static_cast<float>(GetNumber(Args, TEXT("time"), 0.0)),
					static_cast<float>(GetNumber(Args, TEXT("value"), 0.0)));
			}
			else
			{
				UAnimationBlueprintLibrary::RemoveCurve(Sequence, FName(*GetString(Args, TEXT("curve_name"), TEXT("Curve"))));
			}
			Sequence->RefreshCacheData();
			Sequence->GetOutermost()->MarkPackageDirty();
			if (GetBool(Args, TEXT("save"), false)) SaveAsset(Sequence, Error);
			return MakeSuccess();
		}

		if (Operation == TEXT("create_montage"))
		{
			const FString Name = AnimationAssetName(Args);
			UAnimSequence* Source = LoadAnimSequence(Args, Error);
			if (!Source || Name.IsEmpty())
			{
				return MakeErrorObject(Error.IsEmpty() ? TEXT("name and source_sequence are required.") : Error);
			}
			UAnimMontageFactory* Factory = NewObject<UAnimMontageFactory>();
			Factory->SourceAnimation = Source;
			Factory->TargetSkeleton = Source->GetSkeleton();
			IAssetTools& AssetTools = FModuleManager::LoadModuleChecked<FAssetToolsModule>("AssetTools").Get();
			UAnimMontage* Montage = Cast<UAnimMontage>(AssetTools.CreateAsset(Name, AnimationPackagePath(Args), UAnimMontage::StaticClass(), Factory));
			if (!Montage)
			{
				return MakeErrorObject(TEXT("Could not create montage."));
			}
			UAnimMontageFactory::EnsureStartingSection(Montage);
			const FString SlotName = GetString(Args, TEXT("slot_name"), TEXT("DefaultSlot"));
			FSlotAnimationTrack& Slot = EnsureSlot(Montage, SlotName);
			if (Slot.AnimTrack.AnimSegments.Num() == 0)
			{
				Slot.AnimTrack.AnimSegments.Add(MakeSegment(Source, 0.f, 0.f, Source->SequenceLength, 1.f, 1));
			}
			Montage->GetOutermost()->MarkPackageDirty();
			SaveAsset(Montage, Error);
			return SerializeMontage(Montage);
		}

		if (Operation == TEXT("inspect_montage"))
		{
			UAnimMontage* Montage = LoadAnimMontage(Args, Error);
			return Montage ? SerializeMontage(Montage) : MakeErrorObject(Error);
		}

		if (Operation == TEXT("add_montage_slot") || Operation == TEXT("remove_montage_slot")
			|| Operation == TEXT("add_montage_segment") || Operation == TEXT("remove_montage_segment")
			|| Operation == TEXT("add_montage_section") || Operation == TEXT("set_montage_section")
			|| Operation == TEXT("remove_montage_section") || Operation == TEXT("remove_montage_notify")
			|| Operation == TEXT("set_montage_properties"))
		{
			UAnimMontage* Montage = LoadAnimMontage(Args, Error);
			if (!Montage)
			{
				return MakeErrorObject(Error);
			}
			const FString SlotName = GetString(Args, TEXT("slot_name"), TEXT("DefaultSlot"));
			Montage->Modify();
			if (Operation == TEXT("add_montage_slot"))
			{
				FSlotAnimationTrack& Slot = EnsureSlot(Montage, SlotName);
				const FString SequencePath = GetString(Args, TEXT("sequence_path"));
				if (!SequencePath.IsEmpty())
				{
					UAnimSequenceBase* Sequence = Cast<UAnimSequenceBase>(LoadAsset(SequencePath, UAnimSequenceBase::StaticClass(), Error));
					if (!Sequence) return MakeErrorObject(Error);
					Slot.AnimTrack.AnimSegments.Add(MakeSegment(Sequence, 0.f, 0.f, Sequence->SequenceLength, 1.f, 1));
				}
			}
			else if (Operation == TEXT("remove_montage_slot"))
			{
				Montage->SlotAnimTracks.RemoveAll([&](const FSlotAnimationTrack& Slot)
				{
					return Slot.SlotName.ToString().Equals(SlotName, ESearchCase::IgnoreCase);
				});
			}
			else if (Operation == TEXT("add_montage_segment"))
			{
				UAnimSequenceBase* Sequence = Cast<UAnimSequenceBase>(LoadAsset(GetString(Args, TEXT("sequence_path")), UAnimSequenceBase::StaticClass(), Error));
				if (!Sequence) return MakeErrorObject(Error);
				FSlotAnimationTrack& Slot = EnsureSlot(Montage, SlotName);
				Slot.AnimTrack.AnimSegments.Add(MakeSegment(
					Sequence,
					static_cast<float>(GetNumber(Args, TEXT("start_pos"), 0.0)),
					static_cast<float>(GetNumber(Args, TEXT("start_time"), 0.0)),
					static_cast<float>(GetNumber(Args, TEXT("end_time"), 0.0)),
					static_cast<float>(GetNumber(Args, TEXT("play_rate"), 1.0)),
					static_cast<int32>(GetNumber(Args, TEXT("loops"), 1.0))));
			}
			else if (Operation == TEXT("remove_montage_segment"))
			{
				if (FSlotAnimationTrack* Slot = FindSlot(Montage, SlotName))
				{
					const int32 Index = static_cast<int32>(GetNumber(Args, TEXT("segment_index"), 0.0));
					if (Slot->AnimTrack.AnimSegments.IsValidIndex(Index)) Slot->AnimTrack.AnimSegments.RemoveAt(Index);
				}
			}
			else if (Operation == TEXT("add_montage_section"))
			{
				const FName SectionName(*GetString(Args, TEXT("section_name"), TEXT("Section")));
				const int32 Index = Montage->AddAnimCompositeSection(SectionName, static_cast<float>(GetNumber(Args, TEXT("start_time"), 0.0)));
				if (Index == INDEX_NONE) return MakeErrorObject(TEXT("Could not add montage section."));
				if (FCompositeSection* Section = FindSection(Montage, SectionName.ToString(), Index))
				{
					const FString Next = GetString(Args, TEXT("next_section"));
					if (!Next.IsEmpty()) Section->NextSectionName = FName(*Next);
				}
			}
			else if (Operation == TEXT("set_montage_section"))
			{
				FCompositeSection* Section = FindSection(
					Montage,
					GetString(Args, TEXT("section_name")),
					static_cast<int32>(GetNumber(Args, TEXT("section_index"), 0.0)));
				if (!Section) return MakeErrorObject(TEXT("Montage section not found."));
				if (Args.HasField(TEXT("next_section"))) Section->NextSectionName = FName(*GetString(Args, TEXT("next_section")));
				if (Args.HasField(TEXT("start_time"))) Section->SetTime(static_cast<float>(GetNumber(Args, TEXT("start_time"))));
			}
			else if (Operation == TEXT("remove_montage_section"))
			{
				const int32 Index = Montage->GetSectionIndex(FName(*GetString(Args, TEXT("section_name"))));
				if (Index == INDEX_NONE) return MakeErrorObject(TEXT("Montage section not found."));
				Montage->DeleteAnimCompositeSection(Index);
			}
			else if (Operation == TEXT("remove_montage_notify"))
			{
				const FString NotifyName = GetString(Args, TEXT("notify_name"));
				Montage->Notifies.RemoveAll([&](const FAnimNotifyEvent& Event)
				{
					return Event.NotifyName.ToString().Equals(NotifyName, ESearchCase::IgnoreCase);
				});
			}
			else if (Operation == TEXT("set_montage_properties"))
			{
				if (Args.HasField(TEXT("blend_in"))) Montage->BlendIn.SetBlendTime(static_cast<float>(GetNumber(Args, TEXT("blend_in"))));
				if (Args.HasField(TEXT("blend_out"))) Montage->BlendOut.SetBlendTime(static_cast<float>(GetNumber(Args, TEXT("blend_out"))));
				if (Args.HasField(TEXT("blend_out_trigger"))) Montage->BlendOutTriggerTime = static_cast<float>(GetNumber(Args, TEXT("blend_out_trigger")));
				if (Args.HasField(TEXT("auto_blend_out"))) Montage->bEnableAutoBlendOut = GetBool(Args, TEXT("auto_blend_out"));
				if (Args.HasField(TEXT("rate_scale"))) Montage->RateScale = static_cast<float>(GetNumber(Args, TEXT("rate_scale")));
				if (Args.HasField(TEXT("sync_group"))) Montage->SyncGroup = FName(*GetString(Args, TEXT("sync_group")));
			}
			Montage->GetOutermost()->MarkPackageDirty();
			if (GetBool(Args, TEXT("save"), false)) SaveAsset(Montage, Error);
			return SerializeMontage(Montage);
		}

		if (Operation == TEXT("compile"))
		{
			UAnimBlueprint* AnimBlueprint = LoadAnimBlueprint(Args, Error);
			if (!AnimBlueprint)
			{
				return MakeErrorObject(Error);
			}
			FJsonObjectPtr Result;
			CompileBlueprint(AnimBlueprint, Result);
			return Result;
		}

		if (Operation == TEXT("save"))
		{
			UObject* Asset = nullptr;
			if (!GetString(Args, TEXT("montage_path")).IsEmpty())
			{
				Asset = LoadAnimMontage(Args, Error);
			}
			else if (!GetString(Args, TEXT("sequence_path")).IsEmpty())
			{
				Asset = LoadAnimSequence(Args, Error);
			}
			else
			{
				Asset = LoadAsset(AssetIdentifier(Args), UObject::StaticClass(), Error);
				if (Asset && !Asset->IsA(UAnimBlueprint::StaticClass())
					&& !Asset->IsA(UAnimSequence::StaticClass())
					&& !Asset->IsA(UAnimMontage::StaticClass()))
				{
					return MakeErrorObject(TEXT("Save target is not an AnimBlueprint, AnimSequence, or AnimMontage."));
				}
			}
			if (!Asset || !SaveAsset(Asset, Error))
			{
				return MakeErrorObject(Error.IsEmpty() ? TEXT("Asset not found.") : Error);
			}
			return MakeSuccess();
		}

		return MakeErrorObject(FString::Printf(TEXT("Unknown animation asset operation: %s"), *Operation));
	}

	FJsonObjectPtr HandleAnimationOperation(const FString& Operation, const FJsonObject& Args)
	{
		FJsonObjectPtr Result = HandleAnimationOperationInternal(Operation, Args);
		bool bSuccess = false;
		if (!Result.IsValid() || !Result->TryGetBoolField(TEXT("success"), bSuccess) || !bSuccess)
		{
			return Result;
		}
		static const TSet<FString> Mutations = {
			TEXT("set_sequence_properties"), TEXT("add_notify"), TEXT("remove_notify"),
			TEXT("add_notify_track"), TEXT("remove_notify_track"), TEXT("add_sync_marker"),
			TEXT("remove_sync_marker"), TEXT("add_curve_key"), TEXT("remove_curve"),
			TEXT("add_montage_slot"), TEXT("remove_montage_slot"), TEXT("add_montage_segment"),
			TEXT("remove_montage_segment"), TEXT("add_montage_section"), TEXT("set_montage_section"),
			TEXT("remove_montage_section"), TEXT("add_montage_notify"), TEXT("remove_montage_notify"),
			TEXT("set_montage_properties")
		};
		if (!Mutations.Contains(Operation))
		{
			return Result;
		}
		FString Error;
		UObject* Asset = nullptr;
		const bool bMontage = Operation.Contains(TEXT("montage"))
			|| (Operation == TEXT("add_notify") && !GetString(Args, TEXT("montage_path")).IsEmpty());
		if (bMontage)
		{
			Asset = LoadAnimMontage(Args, Error);
		}
		else
		{
			Asset = LoadAnimSequence(Args, Error);
		}
		return Asset ? FinalizeAssetEdit(Asset, Args, Result) : Result;
	}
}
