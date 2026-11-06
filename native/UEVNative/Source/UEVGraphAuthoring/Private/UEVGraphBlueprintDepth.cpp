#include "UEVGraphShared.h"

#include "AssetRegistryModule.h"
#include "EdGraphSchema_K2.h"
#include "Engine/Blueprint.h"
#include "Engine/BlueprintGeneratedClass.h"
#include "Engine/SCS_Node.h"
#include "Engine/SimpleConstructionScript.h"
#include "K2Node_CallFunction.h"
#include "K2Node_CallParentFunction.h"
#include "K2Node_FunctionEntry.h"
#include "K2Node_FunctionResult.h"
#include "K2Node_MacroInstance.h"
#include "K2Node_Tunnel.h"
#include "K2Node_Variable.h"
#include "K2Node_VariableGet.h"
#include "K2Node_VariableSet.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/CompilerResultsLog.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Misc/PackageName.h"
#include "UObject/Package.h"
#include "UObject/UObjectIterator.h"

namespace UEVGraph
{
	namespace
	{
		UK2Node_FunctionEntry* FindFunctionEntry(UEdGraph* Graph)
		{
			if (!Graph)
			{
				return nullptr;
			}
			for (UEdGraphNode* Node : Graph->Nodes)
			{
				if (UK2Node_FunctionEntry* Entry = Cast<UK2Node_FunctionEntry>(Node))
				{
					return Entry;
				}
			}
			return nullptr;
		}

		UK2Node_FunctionResult* FindFunctionResult(UEdGraph* Graph)
		{
			if (!Graph)
			{
				return nullptr;
			}
			for (UEdGraphNode* Node : Graph->Nodes)
			{
				if (UK2Node_FunctionResult* Result = Cast<UK2Node_FunctionResult>(Node))
				{
					return Result;
				}
			}
			return nullptr;
		}

		/** Macro input tunnel (the node with the macro's inputs as output pins). */
		UK2Node_Tunnel* FindMacroEntryTunnel(UEdGraph* Graph)
		{
			if (!Graph)
			{
				return nullptr;
			}
			for (UEdGraphNode* Node : Graph->Nodes)
			{
				if (UK2Node_Tunnel* Tunnel = Cast<UK2Node_Tunnel>(Node))
				{
					if (Tunnel->bCanHaveOutputs && !Cast<UK2Node_MacroInstance>(Tunnel))
					{
						return Tunnel;
					}
				}
			}
			return nullptr;
		}

		/** Macro output tunnel (the node with the macro's outputs as input pins). */
		UK2Node_Tunnel* FindMacroExitTunnel(UEdGraph* Graph)
		{
			if (!Graph)
			{
				return nullptr;
			}
			for (UEdGraphNode* Node : Graph->Nodes)
			{
				if (UK2Node_Tunnel* Tunnel = Cast<UK2Node_Tunnel>(Node))
				{
					if (Tunnel->bCanHaveInputs && !Cast<UK2Node_MacroInstance>(Tunnel))
					{
						return Tunnel;
					}
				}
			}
			return nullptr;
		}

		UK2Node_EditablePinBase* FindEntryPins(UEdGraph* Graph, bool bMacro)
		{
			if (bMacro)
			{
				return Cast<UK2Node_EditablePinBase>(FindMacroEntryTunnel(Graph));
			}
			return Cast<UK2Node_EditablePinBase>(FindFunctionEntry(Graph));
		}

		UK2Node_EditablePinBase* FindExitPins(UEdGraph* Graph, bool bMacro)
		{
			if (bMacro)
			{
				return Cast<UK2Node_EditablePinBase>(FindMacroExitTunnel(Graph));
			}
			return Cast<UK2Node_EditablePinBase>(FindFunctionResult(Graph));
		}

		bool IsMacroGraph(UBlueprint* Blueprint, UEdGraph* Graph)
		{
			return Blueprint && Graph && Blueprint->MacroGraphs.Contains(Graph);
		}

		bool IsFunctionGraph(UBlueprint* Blueprint, UEdGraph* Graph)
		{
			return Blueprint && Graph && Blueprint->FunctionGraphs.Contains(Graph);
		}

		TSharedPtr<FUserPinInfo> FindUserPinInfo(UK2Node_EditablePinBase* Node, const FName& Name)
		{
			if (!Node)
			{
				return nullptr;
			}
			for (const TSharedPtr<FUserPinInfo>& Info : Node->UserDefinedPins)
			{
				if (Info.IsValid() && Info->PinName == Name)
				{
					return Info;
				}
			}
			return nullptr;
		}

		UEdGraphPin* FindUserPin(UK2Node_EditablePinBase* Node, const FName& Name, EEdGraphPinDirection Direction, bool bDirectionKnown)
		{
			if (!Node)
			{
				return nullptr;
			}
			for (UEdGraphPin* Pin : Node->Pins)
			{
				if (!Pin || Pin->PinName != Name)
				{
					continue;
				}
				if (bDirectionKnown && Pin->Direction != Direction)
				{
					continue;
				}
				return Pin;
			}
			return nullptr;
		}

		/** Parse "<node_id>:<pin_name>" pin ids. */
		bool SplitPinId(const FString& PinIdValue, FString& OutNodeId, FString& OutPinName)
		{
			int32 Index = INDEX_NONE;
			if (!PinIdValue.FindChar(TEXT(':'), Index) || Index <= 0 || Index >= PinIdValue.Len() - 1)
			{
				return false;
			}
			OutNodeId = PinIdValue.Left(Index);
			OutPinName = PinIdValue.RightChop(Index + 1);
			return true;
		}

		void AppendUserPins(UK2Node_EditablePinBase* Node, EEdGraphPinDirection Direction, TArray<TSharedPtr<FJsonValue>>& OutPins)
		{
			if (!Node)
			{
				return;
			}
			for (UEdGraphPin* Pin : Node->Pins)
			{
				if (!Pin || Pin->Direction != Direction || Pin->bHidden)
				{
					continue;
				}
				if (Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Exec)
				{
					continue;
				}
				FJsonObjectPtr PinObject = MakeObject();
				PinObject->SetStringField(TEXT("pin_id"), FString::Printf(TEXT("%s:%s"), *NodeId(Node), *Pin->PinName.ToString()));
				PinObject->SetStringField(TEXT("name"), Pin->PinName.ToString());
				PinObject->SetStringField(TEXT("type"), SerializePinTypeField(Pin->PinType));
				PinObject->SetStringField(TEXT("type_detail"), PinTypeName(Pin->PinType));
				PinObject->SetStringField(TEXT("direction"), Direction == EGPD_Output ? TEXT("output") : TEXT("input"));
				PinObject->SetStringField(TEXT("default"), Pin->DefaultValue);
				if (Pin->DefaultObject)
				{
					PinObject->SetStringField(TEXT("default_object"), Pin->DefaultObject->GetPathName());
				}
				if (Pin->LinkedTo.Num() > 0)
				{
					PinObject->SetNumberField(TEXT("link_count"), Pin->LinkedTo.Num());
				}
				OutPins.Add(MakeShared<FJsonValueObject>(PinObject));
			}
		}

		const TCHAR* FunctionFlagName(int32 Flag)
		{
			switch (Flag)
			{
			case FUNC_BlueprintPure: return TEXT("pure");
			case FUNC_Const: return TEXT("const");
			case FUNC_Static: return TEXT("static");
			case FUNC_BlueprintCallable: return TEXT("callable");
			case FUNC_BlueprintEvent: return TEXT("blueprint_event");
			case FUNC_Public: return TEXT("public");
			case FUNC_Net: return TEXT("net");
			default: return nullptr;
			}
		}

		int32 FunctionFlagFromName(const FString& FlagName, bool& bOutKnown)
		{
			bOutKnown = true;
			const FString Lower = FlagName.TrimStartAndEnd().ToLower();
			if (Lower == TEXT("pure") || Lower == TEXT("blueprintpure")) return FUNC_BlueprintPure;
			if (Lower == TEXT("const")) return FUNC_Const;
			if (Lower == TEXT("static")) return FUNC_Static;
			if (Lower == TEXT("callable") || Lower == TEXT("blueprintcallable")) return FUNC_BlueprintCallable;
			if (Lower == TEXT("blueprint_event") || Lower == TEXT("blueprintevent") || Lower == TEXT("event")) return FUNC_BlueprintEvent;
			if (Lower == TEXT("public")) return FUNC_Public;
			if (Lower == TEXT("net")) return FUNC_Net;
			bOutKnown = false;
			return 0;
		}

		FJsonObjectPtr SerializeFunctionFlags(UK2Node_FunctionEntry* Entry)
		{
			const int32 Flags = Entry ? Entry->GetExtraFlags() : 0;
			FJsonObjectPtr Result = MakeObject();
			Result->SetBoolField(TEXT("pure"), (Flags & FUNC_BlueprintPure) != 0);
			Result->SetBoolField(TEXT("const"), (Flags & FUNC_Const) != 0);
			Result->SetBoolField(TEXT("static"), (Flags & FUNC_Static) != 0);
			Result->SetBoolField(TEXT("callable"), (Flags & FUNC_BlueprintCallable) != 0);
			Result->SetBoolField(TEXT("blueprint_event"), (Flags & FUNC_BlueprintEvent) != 0);
			Result->SetBoolField(TEXT("public"), (Flags & FUNC_Public) != 0);
			Result->SetBoolField(TEXT("latent"), Entry ? Entry->MetaData.HasLatentFunctions != INDEX_NONE : false);
			Result->SetBoolField(TEXT("net"), (Flags & FUNC_Net) != 0);
			Result->SetBoolField(TEXT("deprecated"), Entry ? Entry->MetaData.bIsDeprecated : false);
			Result->SetBoolField(TEXT("call_in_editor"), Entry ? Entry->MetaData.bCallInEditor : false);
			Result->SetNumberField(TEXT("raw_flags"), Flags);
			return Result;
		}

		FJsonObjectPtr SerializeFunctionMeta(UK2Node_FunctionEntry* Entry)
		{
			FJsonObjectPtr Result = MakeObject();
			if (!Entry)
			{
				return Result;
			}
			Result->SetStringField(TEXT("category"), Entry->MetaData.Category.ToString());
			Result->SetStringField(TEXT("tooltip"), Entry->MetaData.ToolTip.ToString());
			Result->SetStringField(TEXT("keywords"), Entry->MetaData.Keywords.ToString());
			Result->SetStringField(TEXT("compact_node_title"), Entry->MetaData.CompactNodeTitle.ToString());
			Result->SetStringField(TEXT("deprecated_message"), Entry->MetaData.DeprecationMessage);
			Result->SetBoolField(TEXT("deprecated"), Entry->MetaData.bIsDeprecated);
			Result->SetBoolField(TEXT("call_in_editor"), Entry->MetaData.bCallInEditor);
			Result->SetStringField(TEXT("instance_title_color"), Entry->MetaData.InstanceTitleColor.ToString());
			return Result;
		}

		FJsonObjectPtr SerializeTunnelMeta(UK2Node_Tunnel* Tunnel)
		{
			FJsonObjectPtr Result = MakeObject();
			if (!Tunnel)
			{
				return Result;
			}
			Result->SetStringField(TEXT("category"), Tunnel->MetaData.Category.ToString());
			Result->SetStringField(TEXT("tooltip"), Tunnel->MetaData.ToolTip.ToString());
			Result->SetStringField(TEXT("keywords"), Tunnel->MetaData.Keywords.ToString());
			Result->SetStringField(TEXT("compact_node_title"), Tunnel->MetaData.CompactNodeTitle.ToString());
			Result->SetStringField(TEXT("deprecated_message"), Tunnel->MetaData.DeprecationMessage);
			Result->SetBoolField(TEXT("deprecated"), Tunnel->MetaData.bIsDeprecated);
			return Result;
		}

		FJsonObjectPtr SerializeLocalVariables(UK2Node_FunctionEntry* Entry)
		{
			FJsonObjectPtr Result = MakeObject();
			TArray<TSharedPtr<FJsonValue>> Variables;
			if (Entry)
			{
				for (const FBPVariableDescription& Variable : Entry->LocalVariables)
				{
					FJsonObjectPtr Object = MakeObject();
					Object->SetStringField(TEXT("name"), Variable.VarName.ToString());
					Object->SetStringField(TEXT("type"), SerializePinTypeField(Variable.VarType));
					Object->SetStringField(TEXT("type_detail"), PinTypeName(Variable.VarType));
					Object->SetStringField(TEXT("default"), Variable.DefaultValue);
					Object->SetStringField(TEXT("category"), Variable.Category.ToString());
					Object->SetNumberField(TEXT("property_flags"), static_cast<double>(Variable.PropertyFlags));
					Object->SetBoolField(TEXT("is_blueprint_visible"), (Variable.PropertyFlags & CPF_BlueprintVisible) != 0);
					Object->SetBoolField(TEXT("is_editable"), (Variable.PropertyFlags & CPF_Edit) != 0);
					Variables.Add(MakeShared<FJsonValueObject>(Object));
				}
			}
			Result->SetArrayField(TEXT("variables"), Variables);
			return Result;
		}

		void AppendLocalVariableArray(UK2Node_FunctionEntry* Entry, TArray<TSharedPtr<FJsonValue>>& OutVariables)
		{
			FJsonObjectPtr Container = SerializeLocalVariables(Entry);
			const TArray<TSharedPtr<FJsonValue>>* Variables = nullptr;
			if (Container->TryGetArrayField(TEXT("variables"), Variables) && Variables)
			{
				OutVariables.Append(*Variables);
			}
		}

		/** Apply the add/rename/remove pin edits described by Args onto one signature (inputs on Entry, outputs on Exit). */
		struct FSignatureEdits
		{
			TArray<TSharedPtr<FJsonValue>> Added;
			TArray<TSharedPtr<FJsonValue>> Removed;
			TArray<TSharedPtr<FJsonValue>> Renamed;
			TArray<TSharedPtr<FJsonValue>> OrphanedLinks;
			TArray<TSharedPtr<FJsonValue>> Warnings;
			bool bChanged = false;

			void Warn(const FString& Message)
			{
				Warnings.Add(MakeShared<FJsonValueString>(Message));
			}
		};

		FJsonObjectPtr MakePinSummary(UEdGraphPin* Pin, UK2Node_EditablePinBase* Node)
		{
			FJsonObjectPtr Object = MakeObject();
			if (Pin)
			{
				Object->SetStringField(TEXT("pin_id"), FString::Printf(TEXT("%s:%s"), *NodeId(Node), *Pin->PinName.ToString()));
				Object->SetStringField(TEXT("name"), Pin->PinName.ToString());
				Object->SetStringField(TEXT("type"), SerializePinTypeField(Pin->PinType));
				Object->SetStringField(TEXT("direction"), Pin->Direction == EGPD_Output ? TEXT("output") : TEXT("input"));
			}
			return Object;
		}

		bool ApplyPinDefaultsToPin(UEdGraphPin* Pin, const FString& DefaultValue, FSignatureEdits& Edits)
		{
			if (!Pin || DefaultValue.IsEmpty())
			{
				return true;
			}
			FString Error;
			if (!SetPinDefault(Pin, MakeShared<FJsonValueString>(DefaultValue), Error))
			{
				Edits.Warn(FString::Printf(TEXT("Could not apply default value '%s' to pin '%s': %s"), *DefaultValue, *Pin->PinName.ToString(), *Error));
				return false;
			}
			return true;
		}

		/**
		 * Apply one signature edit set. EntryPins owns the inputs (output-direction user pins), ExitPins owns
		 * the outputs (input-direction user pins). ExitPins may be null when no outputs are requested.
		 */
		bool ApplySignatureEdits(
			UK2Node_EditablePinBase* EntryPins,
			UK2Node_EditablePinBase* ExitPins,
			const FJsonObject& Args,
			bool bAllowSignatureEdit,
			FSignatureEdits& Edits,
			FJsonObjectPtr& OutError)
		{
			if (!EntryPins)
			{
				OutError = MakeCodedError(TEXT("not_a_function_graph"), TEXT("This graph has no editable signature node."));
				return false;
			}
			if (!bAllowSignatureEdit)
			{
				OutError = MakeCodedError(
					TEXT("construction_script_read_only"),
					TEXT("The Construction Script is bound to AActor::UserConstructionScript; its signature cannot be edited. Use add_node/reset_construction_script instead."));
				return false;
			}

			TArray<FString> ExistingNames;
			for (const TSharedPtr<FUserPinInfo>& Info : EntryPins->UserDefinedPins)
			{
				if (Info.IsValid())
				{
					ExistingNames.Add(Info->PinName.ToString().ToLower());
				}
			}
			if (ExitPins)
			{
				for (const TSharedPtr<FUserPinInfo>& Info : ExitPins->UserDefinedPins)
				{
					if (Info.IsValid())
					{
						ExistingNames.Add(Info->PinName.ToString().ToLower());
					}
				}
			}

			// --- additions -------------------------------------------------------------
			auto AddPins = [&](UK2Node_EditablePinBase* Node, const TCHAR* Field, EEdGraphPinDirection Direction) -> bool
			{
				const TArray<TSharedPtr<FJsonValue>>* PinArray = GetArray(Args, Field);
				if (!PinArray)
				{
					return true;
				}
				for (const TSharedPtr<FJsonValue>& Value : *PinArray)
				{
					const TSharedPtr<FJsonObject> PinArgs = Value.IsValid() ? Value->AsObject() : nullptr;
					if (!PinArgs.IsValid())
					{
						OutError = MakeCodedError(TEXT("invalid_argument"), FString::Printf(TEXT("%s entries must be objects with name/type."), Field));
						return false;
					}
					const FString PinName = GetString(*PinArgs, TEXT("name"), GetString(*PinArgs, TEXT("pin_name"))).TrimStartAndEnd();
					if (PinName.IsEmpty())
					{
						OutError = MakeCodedError(TEXT("invalid_argument"), FString::Printf(TEXT("%s entries require a name."), Field));
						return false;
					}
					FString TypeError;
					FEdGraphPinType PinType;
					if (!PinTypeFromArgs(*PinArgs, TEXT("type"), TEXT("bool"), PinType, TypeError))
					{
						OutError = MakeCodedError(TEXT("invalid_pin_type"), FString::Printf(TEXT("Pin '%s': %s"), *PinName, *TypeError));
						return false;
					}
					if (ExistingNames.Contains(PinName.ToLower()))
					{
						OutError = MakeCodedError(TEXT("duplicate_pin_name"), FString::Printf(TEXT("Pin name already in use: %s"), *PinName));
						return false;
					}
					UEdGraphPin* Created = Node->CreateUserDefinedPin(FName(*PinName), PinType, Direction, false);
					if (!Created)
					{
						OutError = MakeCodedError(TEXT("pin_creation_failed"), FString::Printf(TEXT("Could not create pin: %s"), *PinName));
						return false;
					}
					ExistingNames.Add(PinName.ToLower());
					const FString DefaultValue = GetString(*PinArgs, TEXT("default"));
					if (!DefaultValue.IsEmpty())
					{
						if (TSharedPtr<FUserPinInfo> Info = FindUserPinInfo(Node, FName(*PinName)))
						{
							Info->PinDefaultValue = DefaultValue;
						}
						ApplyPinDefaultsToPin(Created, DefaultValue, Edits);
					}
					Edits.Added.Add(MakeShared<FJsonValueObject>(MakePinSummary(Created, Node)));
					Edits.bChanged = true;
				}
				return true;
			};

			if (ExitPins)
			{
				ExitPins->Modify();
			}
			EntryPins->Modify();

			if (ExitPins && !AddPins(ExitPins, TEXT("add_outputs"), EGPD_Input))
			{
				return false;
			}
			if (!AddPins(EntryPins, TEXT("add_inputs"), EGPD_Output))
			{
				return false;
			}

			// --- renames ---------------------------------------------------------------
			if (const TArray<TSharedPtr<FJsonValue>>* RenameArray = GetArray(Args, TEXT("rename_pins")))
			{
				for (const TSharedPtr<FJsonValue>& Value : *RenameArray)
				{
					const TSharedPtr<FJsonObject> RenameArgs = Value.IsValid() ? Value->AsObject() : nullptr;
					if (!RenameArgs.IsValid())
					{
						OutError = MakeCodedError(TEXT("invalid_argument"), TEXT("rename_pins entries must be objects with from/to."));
						return false;
					}
					const FString OldName = GetString(*RenameArgs, TEXT("from"), GetString(*RenameArgs, TEXT("name"))).TrimStartAndEnd();
					const FString NewName = GetString(*RenameArgs, TEXT("to"), GetString(*RenameArgs, TEXT("new_name"))).TrimStartAndEnd();
					if (OldName.IsEmpty() || NewName.IsEmpty())
					{
						OutError = MakeCodedError(TEXT("invalid_argument"), TEXT("rename_pins entries require from and to."));
						return false;
					}
					UK2Node_EditablePinBase* Owner = nullptr;
					if (FindUserPin(EntryPins, FName(*OldName), EGPD_Output, true))
					{
						Owner = EntryPins;
					}
					else if (ExitPins && FindUserPin(ExitPins, FName(*OldName), EGPD_Input, true))
					{
						Owner = ExitPins;
					}
					if (!Owner)
					{
						OutError = MakeCodedError(TEXT("pin_not_found"), FString::Printf(TEXT("Pin not found: %s"), *OldName));
						return false;
					}
					if (ExistingNames.Contains(NewName.ToLower()) && !NewName.Equals(OldName, ESearchCase::IgnoreCase))
					{
						OutError = MakeCodedError(TEXT("duplicate_pin_name"), FString::Printf(TEXT("Pin name already in use: %s"), *NewName));
						return false;
					}
					const ERenamePinResult RenameResult = Owner->RenameUserDefinedPin(FName(*OldName), FName(*NewName), false);
					if (RenameResult != ERenamePinResult_Success)
					{
						OutError = MakeCodedError(
							TEXT("pin_rename_failed"),
							FString::Printf(TEXT("Could not rename pin %s -> %s (%s)"),
								*OldName, *NewName, RenameResult == ERenamePinResult_NameCollision ? TEXT("name collision") : TEXT("no such pin")));
						return false;
					}
					// UK2Node::RenameUserDefinedPinImpl only renames the transient UEdGraphPin; the
					// editable-pin record drives ReconstructNode, so keep it in sync or the old name returns.
					if (TSharedPtr<FUserPinInfo> RenamedInfo = FindUserPinInfo(Owner, FName(*OldName)))
					{
						RenamedInfo->PinName = FName(*NewName);
					}
					FJsonObjectPtr Renamed = MakeObject();
					Renamed->SetStringField(TEXT("from"), OldName);
					Renamed->SetStringField(TEXT("to"), NewName);
					Renamed->SetStringField(TEXT("pin_id"), FindUserPin(Owner, FName(*NewName), Owner == EntryPins ? EGPD_Output : EGPD_Input, true)
						? FString::Printf(TEXT("%s:%s"), *NodeId(Owner), *NewName) : FString());
					Edits.Renamed.Add(MakeShared<FJsonValueObject>(Renamed));
					ExistingNames.Remove(OldName.ToLower());
					ExistingNames.Add(NewName.ToLower());
					Edits.bChanged = true;
				}
			}

			// --- removals --------------------------------------------------------------
			if (const TArray<TSharedPtr<FJsonValue>>* RemoveArray = GetArray(Args, TEXT("remove_pins")))
			{
				for (const TSharedPtr<FJsonValue>& Value : *RemoveArray)
				{
					FString Requested;
					FString DirectionHint;
					if (Value.IsValid() && Value->Type == EJson::Object)
					{
						const TSharedPtr<FJsonObject> RemoveArgs = Value->AsObject();
						Requested = GetString(*RemoveArgs, TEXT("pin_id"), GetString(*RemoveArgs, TEXT("name")));
						DirectionHint = GetString(*RemoveArgs, TEXT("direction"));
					}
					else if (Value.IsValid())
					{
						Requested = Value->AsString();
					}
					Requested = Requested.TrimStartAndEnd();
					if (Requested.IsEmpty())
					{
						OutError = MakeCodedError(TEXT("invalid_argument"), TEXT("remove_pins entries require a pin_id or name."));
						return false;
					}

					FString NodePart;
					FString PinPart;
					const bool bPinIdForm = SplitPinId(Requested, NodePart, PinPart);
					const FString PinName = bPinIdForm ? PinPart : Requested;

					UK2Node_EditablePinBase* Owner = nullptr;
					EEdGraphPinDirection Direction = EGPD_Output;
					bool bDirectionKnown = false;
					if (DirectionHint.Equals(TEXT("input"), ESearchCase::IgnoreCase))
					{
						Direction = EGPD_Input;
						bDirectionKnown = true;
					}
					else if (DirectionHint.Equals(TEXT("output"), ESearchCase::IgnoreCase))
					{
						Direction = EGPD_Output;
						bDirectionKnown = true;
					}

					UEdGraphPin* Pin = nullptr;
					if (bPinIdForm && NodeId(EntryPins).Equals(NodePart, ESearchCase::IgnoreCase))
					{
						Owner = EntryPins;
						Pin = FindUserPin(EntryPins, FName(*PinName), EGPD_Output, true);
					}
					else if (ExitPins && bPinIdForm && NodeId(ExitPins).Equals(NodePart, ESearchCase::IgnoreCase))
					{
						Owner = ExitPins;
						Pin = FindUserPin(ExitPins, FName(*PinName), EGPD_Input, true);
					}
					if (!Pin && (!bPinIdForm || !Owner))
					{
						Pin = FindUserPin(EntryPins, FName(*PinName), EGPD_Output, true);
						if (Pin)
						{
							Owner = EntryPins;
						}
						else if (ExitPins)
						{
							Pin = FindUserPin(ExitPins, FName(*PinName), EGPD_Input, true);
							if (Pin)
							{
								Owner = ExitPins;
							}
						}
					}
					if (!Pin || !Owner)
					{
						// Removing an absent pin is a no-op: the action stays idempotent.
						FJsonObjectPtr Missing = MakeObject();
						Missing->SetStringField(TEXT("pin_id"), Requested);
						Missing->SetStringField(TEXT("status"), TEXT("not_found"));
						Edits.Removed.Add(MakeShared<FJsonValueObject>(Missing));
						continue;
					}

					Owner->Modify();
					TArray<UEdGraphPin*> Links = Pin->LinkedTo;
					for (UEdGraphPin* LinkedPin : Links)
					{
						if (!LinkedPin)
						{
							continue;
						}
						FJsonObjectPtr Orphan = MakeObject();
						Orphan->SetStringField(TEXT("pin_id"), FString::Printf(TEXT("%s:%s"), *NodeId(LinkedPin->GetOwningNode()), *LinkedPin->PinName.ToString()));
						Orphan->SetStringField(TEXT("removed_pin"), FString::Printf(TEXT("%s:%s"), *NodeId(Owner), *PinName));
						Edits.OrphanedLinks.Add(MakeShared<FJsonValueObject>(Orphan));
					}
					const FJsonObjectPtr RemovedSummary = MakePinSummary(Pin, Owner);
					Pin->BreakAllPinLinks();
					Owner->RemoveUserDefinedPinByName(FName(*PinName));
					Edits.Removed.Add(MakeShared<FJsonValueObject>(RemovedSummary));
					ExistingNames.Remove(PinName.ToLower());
					Edits.bChanged = true;
				}
			}

			if (Edits.bChanged)
			{
				EntryPins->ReconstructNode();
				if (ExitPins)
				{
					ExitPins->ReconstructNode();
				}
				EntryPins->UpdateUserDefinedPinDefaultValues();
				if (ExitPins)
				{
					ExitPins->UpdateUserDefinedPinDefaultValues();
				}
			}
			return true;
		}

		bool ApplyFunctionFlags(UK2Node_FunctionEntry* Entry, const FJsonObject& Args, FSignatureEdits& Edits)
		{
			if (!Entry || !Args.HasField(TEXT("flags")))
			{
				return true;
			}
			int32 Flags = Entry->GetExtraFlags();
			bool bAny = false;
			if (const TSharedPtr<FJsonObject> FlagObject = GetObject(Args, TEXT("flags")))
			{
				for (const auto& Pair : FlagObject->Values)
				{
					if (!Pair.Value.IsValid() || Pair.Value->Type != EJson::Boolean)
					{
						continue;
					}
					bool bKnown = false;
					const int32 Flag = FunctionFlagFromName(Pair.Key, bKnown);
					if (!bKnown)
					{
						Edits.Warn(FString::Printf(TEXT("Ignoring unknown function flag: %s"), *Pair.Key));
						continue;
					}
					if (Pair.Value->AsBool())
					{
						Flags |= Flag;
					}
					else
					{
						Flags &= ~Flag;
					}
					bAny = true;
				}
			}
			else if (const TArray<TSharedPtr<FJsonValue>>* FlagArray = GetArray(Args, TEXT("flags")))
			{
				for (const TSharedPtr<FJsonValue>& Value : *FlagArray)
				{
					if (!Value.IsValid())
					{
						continue;
					}
					bool bKnown = false;
					const int32 Flag = FunctionFlagFromName(Value->AsString(), bKnown);
					if (!bKnown)
					{
						Edits.Warn(FString::Printf(TEXT("Ignoring unknown function flag: %s"), *Value->AsString()));
						continue;
					}
					Flags |= Flag;
					bAny = true;
				}
			}
			if (bAny)
			{
				Entry->Modify();
				Entry->SetExtraFlags(Flags);
			}
			return true;
		}

		void ApplyFunctionMeta(UK2Node_FunctionEntry* Entry, const FJsonObject& Args)
		{
			if (!Entry)
			{
				return;
			}
			const TSharedPtr<FJsonObject> MetaArgs = GetObject(Args, TEXT("meta"));
			auto HasAny = [&](const TCHAR* Key) { return (MetaArgs.IsValid() && MetaArgs->HasField(Key)) || Args.HasField(Key); };
			auto ReadString = [&](const TCHAR* Key) -> FString
			{
				if (MetaArgs.IsValid() && MetaArgs->HasField(Key))
				{
					return GetString(*MetaArgs, Key);
				}
				return GetString(Args, Key);
			};
			auto ReadBool = [&](const TCHAR* Key, bool& bOutValue) -> bool
			{
				if (MetaArgs.IsValid() && MetaArgs->HasField(Key))
				{
					bOutValue = GetBool(*MetaArgs, Key);
					return true;
				}
				if (Args.HasField(Key))
				{
					bOutValue = GetBool(Args, Key);
					return true;
				}
				return false;
			};

			bool bDirty = false;
			if (HasAny(TEXT("category")))
			{
				Entry->MetaData.Category = FText::FromString(ReadString(TEXT("category")));
				bDirty = true;
			}
			if (HasAny(TEXT("tooltip")))
			{
				Entry->MetaData.ToolTip = FText::FromString(ReadString(TEXT("tooltip")));
				bDirty = true;
			}
			if (HasAny(TEXT("keywords")))
			{
				Entry->MetaData.Keywords = FText::FromString(ReadString(TEXT("keywords")));
				bDirty = true;
			}
			if (HasAny(TEXT("compact_node_title")))
			{
				Entry->MetaData.CompactNodeTitle = FText::FromString(ReadString(TEXT("compact_node_title")));
				bDirty = true;
			}
			if (HasAny(TEXT("deprecated_message")))
			{
				Entry->MetaData.DeprecationMessage = ReadString(TEXT("deprecated_message"));
				bDirty = true;
			}
			bool bValue = false;
			if (ReadBool(TEXT("deprecated"), bValue))
			{
				Entry->MetaData.bIsDeprecated = bValue;
				bDirty = true;
			}
			if (ReadBool(TEXT("call_in_editor"), bValue))
			{
				Entry->MetaData.bCallInEditor = bValue;
				bDirty = true;
			}
			if (bDirty)
			{
				Entry->Modify();
			}
		}

		void ApplyTunnelMeta(UK2Node_Tunnel* EntryTunnel, UK2Node_Tunnel* ExitTunnel, const FJsonObject& Args)
		{
			const TSharedPtr<FJsonObject> MetaArgs = GetObject(Args, TEXT("meta"));
			auto HasAny = [&](const TCHAR* Key) { return (MetaArgs.IsValid() && MetaArgs->HasField(Key)) || Args.HasField(Key); };
			auto ReadString = [&](const TCHAR* Key) -> FString
			{
				if (MetaArgs.IsValid() && MetaArgs->HasField(Key))
				{
					return GetString(*MetaArgs, Key);
				}
				return GetString(Args, Key);
			};
			auto Apply = [&](UK2Node_Tunnel* Tunnel)
			{
				if (!Tunnel)
				{
					return;
				}
				bool bDirty = false;
				if (HasAny(TEXT("category")))
				{
					Tunnel->MetaData.Category = FText::FromString(ReadString(TEXT("category")));
					bDirty = true;
				}
				if (HasAny(TEXT("tooltip")) || HasAny(TEXT("description")))
				{
					const FString Tooltip = HasAny(TEXT("tooltip")) ? ReadString(TEXT("tooltip")) : ReadString(TEXT("description"));
					Tunnel->MetaData.ToolTip = FText::FromString(Tooltip);
					bDirty = true;
				}
				if (HasAny(TEXT("keywords")))
				{
					Tunnel->MetaData.Keywords = FText::FromString(ReadString(TEXT("keywords")));
					bDirty = true;
				}
				if (HasAny(TEXT("compact_node_title")))
				{
					Tunnel->MetaData.CompactNodeTitle = FText::FromString(ReadString(TEXT("compact_node_title")));
					bDirty = true;
				}
				if (HasAny(TEXT("deprecated_message")))
				{
					Tunnel->MetaData.DeprecationMessage = ReadString(TEXT("deprecated_message"));
					bDirty = true;
				}
				if (HasAny(TEXT("deprecated")))
				{
					Tunnel->MetaData.bIsDeprecated = (MetaArgs.IsValid() && MetaArgs->HasField(TEXT("deprecated")))
						? GetBool(*MetaArgs, TEXT("deprecated"))
						: GetBool(Args, TEXT("deprecated"));
					bDirty = true;
				}
				if (bDirty)
				{
					Tunnel->Modify();
				}
			};
			Apply(EntryTunnel);
			Apply(ExitTunnel);
		}
		bool IsCallSiteForFunction(UBlueprint* Candidate, UBlueprint* Owner, UK2Node_CallFunction* Call)
		{
			if (!Call)
			{
				return false;
			}
			if (Call->FunctionReference.IsSelfContext())
			{
				return Candidate == Owner;
			}
			UClass* ParentClass = Call->FunctionReference.GetMemberParentClass();
			if (!ParentClass || !Owner || !Owner->GeneratedClass)
			{
				return false;
			}
			return ParentClass == Owner->GeneratedClass || ParentClass->IsChildOf(Owner->GeneratedClass);
		}

		bool IsIteratorBlueprintUsable(UBlueprint* Blueprint)
		{
			if (!Blueprint || Blueprint->HasAnyFlags(RF_Transient | RF_ClassDefaultObject))
			{
				return false;
			}
			UPackage* Package = Blueprint->GetOutermost();
			return Package && !Package->HasAnyFlags(RF_Transient) && !Blueprint->GetName().StartsWith(TEXT("SKEL_"));
		}

		struct FFunctionPinSets
		{
			TSet<FString> InputNames;
			TSet<FString> OutputNames;
		};

		FFunctionPinSets CollectSignaturePinNames(UEdGraph* Graph)
		{
			FFunctionPinSets Sets;
			if (!Graph)
			{
				return Sets;
			}
			const bool bMacro = IsMacroGraph(FindOwningBlueprint(Graph), Graph);
			if (UK2Node_EditablePinBase* EntryPins = FindEntryPins(Graph, bMacro))
			{
				for (UEdGraphPin* Pin : EntryPins->Pins)
				{
					if (Pin && Pin->Direction == EGPD_Output && !Pin->bHidden)
					{
						Sets.InputNames.Add(Pin->PinName.ToString());
					}
				}
			}
			if (UK2Node_EditablePinBase* ExitPins = FindExitPins(Graph, bMacro))
			{
				for (UEdGraphPin* Pin : ExitPins->Pins)
				{
					if (Pin && Pin->Direction == EGPD_Input && !Pin->bHidden)
					{
						Sets.OutputNames.Add(Pin->PinName.ToString());
					}
				}
			}
			return Sets;
		}

		void AppendStalePinsForNode(UEdGraphNode* Node, const FFunctionPinSets& Sets, TArray<TSharedPtr<FJsonValue>>& OutStalePins)
		{
			if (!Node)
			{
				return;
			}
			for (UEdGraphPin* Pin : Node->Pins)
			{
				if (!Pin || Pin->bHidden)
				{
					continue;
				}
				const FString PinName = Pin->PinName.ToString();
				if (Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Exec
					|| PinName.Equals(TEXT("self"), ESearchCase::IgnoreCase))
				{
					continue;
				}
				const bool bKnown = Pin->Direction == EGPD_Input
					? Sets.InputNames.Contains(PinName)
					: Sets.OutputNames.Contains(PinName);
				if (!bKnown)
				{
					OutStalePins.Add(MakeShared<FJsonValueString>(PinName));
				}
			}
		}

		void CollectFunctionCallSites(
			UBlueprint* Owner,
			UEdGraph* FunctionGraph,
			TArray<TSharedPtr<FJsonValue>>& OutSites,
			TArray<TSharedPtr<FJsonValue>>* OutStaleSites)
		{
			if (!Owner || !FunctionGraph)
			{
				return;
			}
			const FName FunctionName(*FunctionGraph->GetName());
			const FFunctionPinSets PinSets = CollectSignaturePinNames(FunctionGraph);
			for (TObjectIterator<UBlueprint> It; It; ++It)
			{
				UBlueprint* Candidate = *It;
				if (!IsIteratorBlueprintUsable(Candidate))
				{
					continue;
				}
				TArray<UEdGraph*> Graphs;
				AppendGraphs(Candidate, Graphs, true);
				for (UEdGraph* Graph : Graphs)
				{
					if (!Graph)
					{
						continue;
					}
					for (UEdGraphNode* Node : Graph->Nodes)
					{
						UK2Node_CallFunction* Call = Cast<UK2Node_CallFunction>(Node);
						if (!Call || Call->GetFunctionName() != FunctionName || !IsCallSiteForFunction(Candidate, Owner, Call))
						{
							continue;
						}
						FJsonObjectPtr Site = MakeObject();
						Site->SetStringField(TEXT("blueprint"), Candidate->GetPathName());
						Site->SetStringField(TEXT("graph"), Graph->GetName());
						Site->SetStringField(TEXT("graph_id"), GraphId(Graph));
						Site->SetStringField(TEXT("node_id"), NodeId(Node));
						OutSites.Add(MakeShared<FJsonValueObject>(Site));

						if (OutStaleSites)
						{
							TArray<TSharedPtr<FJsonValue>> StalePins;
							AppendStalePinsForNode(Node, PinSets, StalePins);
							if (StalePins.Num() > 0)
							{
								FJsonObjectPtr Stale = MakeObject();
								Stale->SetStringField(TEXT("blueprint"), Candidate->GetPathName());
								Stale->SetStringField(TEXT("graph"), Graph->GetName());
								Stale->SetStringField(TEXT("node_id"), NodeId(Node));
								Stale->SetArrayField(TEXT("stale_pins"), StalePins);
								OutStaleSites->Add(MakeShared<FJsonValueObject>(Stale));
							}
						}
					}
				}
			}
		}

		void CollectMacroInstances(
			UEdGraph* MacroGraph,
			TArray<TSharedPtr<FJsonValue>>& OutInstances,
			TArray<UK2Node_MacroInstance*>* OutNodes = nullptr,
			TArray<UBlueprint*>* OutBlueprints = nullptr)
		{
			if (!MacroGraph)
			{
				return;
			}
			const FFunctionPinSets PinSets = CollectSignaturePinNames(MacroGraph);
			for (TObjectIterator<UBlueprint> It; It; ++It)
			{
				UBlueprint* Candidate = *It;
				if (!IsIteratorBlueprintUsable(Candidate))
				{
					continue;
				}
				TArray<UEdGraph*> Graphs;
				AppendGraphs(Candidate, Graphs, true);
				for (UEdGraph* Graph : Graphs)
				{
					if (!Graph)
					{
						continue;
					}
					for (UEdGraphNode* Node : Graph->Nodes)
					{
						UK2Node_MacroInstance* Instance = Cast<UK2Node_MacroInstance>(Node);
						if (!Instance || Instance->GetMacroGraph() != MacroGraph)
						{
							continue;
						}
						FJsonObjectPtr Entry = MakeObject();
						Entry->SetStringField(TEXT("blueprint"), Candidate->GetPathName());
						Entry->SetStringField(TEXT("graph"), Graph->GetName());
						Entry->SetStringField(TEXT("graph_id"), GraphId(Graph));
						Entry->SetStringField(TEXT("node_id"), NodeId(Node));
						TArray<TSharedPtr<FJsonValue>> StalePins;
						AppendStalePinsForNode(Node, PinSets, StalePins);
						Entry->SetArrayField(TEXT("stale_pins"), StalePins);
						OutInstances.Add(MakeShared<FJsonValueObject>(Entry));
						if (OutNodes)
						{
							OutNodes->Add(Instance);
						}
						if (OutBlueprints && !OutBlueprints->Contains(Candidate))
						{
							OutBlueprints->Add(Candidate);
						}
					}
				}
			}
		}

		FJsonObjectPtr BuildFunctionSummary(UBlueprint* Blueprint, UEdGraph* Graph)
		{
			FJsonObjectPtr Result = MakeObject();
			if (!Blueprint || !Graph)
			{
				return Result;
			}
			UK2Node_FunctionEntry* Entry = FindFunctionEntry(Graph);
			UK2Node_FunctionResult* ResultNode = FindFunctionResult(Graph);
			Result->SetStringField(TEXT("graph_id"), GraphId(Graph));
			Result->SetStringField(TEXT("name"), Graph->GetName());
			Result->SetStringField(TEXT("kind"), GraphKind(Graph));
			Result->SetStringField(TEXT("owner"), Blueprint->GetPathName());
			Result->SetBoolField(TEXT("is_construction_script"), IsConstructionScriptGraph(Blueprint, Graph));
			Result->SetStringField(TEXT("entry_node_id"), NodeId(Entry));
			Result->SetObjectField(TEXT("flags"), SerializeFunctionFlags(Entry));
			Result->SetObjectField(TEXT("meta"), SerializeFunctionMeta(Entry));

			TArray<TSharedPtr<FJsonValue>> Inputs;
			AppendUserPins(Entry, EGPD_Output, Inputs);
			Result->SetArrayField(TEXT("inputs"), Inputs);

			TArray<TSharedPtr<FJsonValue>> Outputs;
			if (ResultNode)
			{
				AppendUserPins(ResultNode, EGPD_Input, Outputs);
			}
			Result->SetArrayField(TEXT("outputs"), Outputs);

			TArray<TSharedPtr<FJsonValue>> LocalVariables;
			AppendLocalVariableArray(Entry, LocalVariables);
			Result->SetArrayField(TEXT("local_variables"), LocalVariables);
			Result->SetNumberField(TEXT("node_count"), Graph->Nodes.Num());
			return Result;
		}

		FJsonObjectPtr BuildMacroSummary(UBlueprint* Blueprint, UEdGraph* Graph, bool bIncludeInstances)
		{
			FJsonObjectPtr Result = MakeObject();
			if (!Blueprint || !Graph)
			{
				return Result;
			}
			UK2Node_Tunnel* EntryTunnel = FindMacroEntryTunnel(Graph);
			UK2Node_Tunnel* ExitTunnel = FindMacroExitTunnel(Graph);
			Result->SetStringField(TEXT("graph_id"), GraphId(Graph));
			Result->SetStringField(TEXT("name"), Graph->GetName());
			Result->SetStringField(TEXT("kind"), GraphKind(Graph));
			Result->SetStringField(TEXT("library_path"), Blueprint->GetPathName());
			Result->SetObjectField(TEXT("meta"), SerializeTunnelMeta(EntryTunnel));
			Result->SetStringField(TEXT("description"), EntryTunnel ? EntryTunnel->MetaData.ToolTip.ToString() : FString());

			TArray<TSharedPtr<FJsonValue>> Inputs;
			AppendUserPins(Cast<UK2Node_EditablePinBase>(EntryTunnel), EGPD_Output, Inputs);
			Result->SetArrayField(TEXT("inputs"), Inputs);

			TArray<TSharedPtr<FJsonValue>> Outputs;
			AppendUserPins(Cast<UK2Node_EditablePinBase>(ExitTunnel), EGPD_Input, Outputs);
			Result->SetArrayField(TEXT("outputs"), Outputs);

			Result->SetNumberField(TEXT("node_count"), Graph->Nodes.Num());
			if (bIncludeInstances)
			{
				TArray<TSharedPtr<FJsonValue>> Instances;
				CollectMacroInstances(Graph, Instances);
				Result->SetNumberField(TEXT("instance_count"), Instances.Num());
				Result->SetArrayField(TEXT("instances"), Instances);
			}
			return Result;
		}

		FJsonObjectPtr BuildConstructionScriptSummary(UBlueprint* Blueprint)
		{
			FJsonObjectPtr Result = MakeObject();
			if (!Blueprint)
			{
				return Result;
			}
			Result->SetBoolField(TEXT("supported"), FBlueprintEditorUtils::SupportsConstructionScript(Blueprint));
			UEdGraph* Graph = FBlueprintEditorUtils::FindUserConstructionScript(Blueprint);
			Result->SetBoolField(TEXT("exists"), Graph != nullptr);
			TArray<TSharedPtr<FJsonValue>> Warnings;
			if (!Graph)
			{
				Result->SetBoolField(TEXT("requires_pie_verification"), false);
				return Result;
			}
			UK2Node_FunctionEntry* Entry = FindFunctionEntry(Graph);
			UK2Node_FunctionResult* ResultNode = FindFunctionResult(Graph);
			Result->SetStringField(TEXT("graph_id"), GraphId(Graph));
			Result->SetStringField(TEXT("name"), Graph->GetName());
			Result->SetStringField(TEXT("entry_node_id"), NodeId(Entry));
			Result->SetStringField(TEXT("result_node_id"), NodeId(ResultNode));

			FString ParentCallNodeId;
			for (UEdGraphNode* Node : Graph->Nodes)
			{
				if (UK2Node_CallParentFunction* ParentCall = Cast<UK2Node_CallParentFunction>(Node))
				{
					ParentCallNodeId = NodeId(ParentCall);
					break;
				}
			}
			Result->SetStringField(TEXT("parent_call_node_id"), ParentCallNodeId);

			TArray<TSharedPtr<FJsonValue>> Nodes;
			TArray<TSharedPtr<FJsonValue>> OrphanedNodes;
			for (UEdGraphNode* Node : Graph->Nodes)
			{
				if (!Node)
				{
					continue;
				}
				Nodes.Add(MakeShared<FJsonValueObject>(SerializeNode(Node, Graph)));
				if (Node == Entry || Node == ResultNode)
				{
					continue;
				}
				bool bAnyLink = false;
				for (UEdGraphPin* Pin : Node->Pins)
				{
					if (Pin && Pin->LinkedTo.Num() > 0)
					{
						bAnyLink = true;
						break;
					}
				}
				if (!bAnyLink)
				{
					OrphanedNodes.Add(MakeShared<FJsonValueString>(NodeId(Node)));
				}
			}
			Result->SetArrayField(TEXT("nodes"), Nodes);
			Result->SetArrayField(TEXT("orphaned_nodes"), OrphanedNodes);

			bool bConnected = false;
			if (Entry)
			{
				for (UEdGraphPin* Pin : Entry->Pins)
				{
					if (Pin && Pin->LinkedTo.Num() > 0)
					{
						bConnected = true;
						break;
					}
				}
			}
			Result->SetBoolField(TEXT("connected"), bConnected);
			Result->SetBoolField(TEXT("requires_pie_verification"), true);
			Warnings.Add(MakeShared<FJsonValueString>(TEXT("Construction Script behavior must be verified in PIE: it runs on spawn and in the editor preview.")));
			Result->SetArrayField(TEXT("warnings"), Warnings);
			return Result;
		}

		FJsonObjectPtr BuildBlueprintModel(UBlueprint* Blueprint, bool bIncludeGraphs, bool bIncludeFunctions, bool bIncludeMacros, bool bIncludeComponents)
		{
			FJsonObjectPtr Result = MakeObject();
			if (!Blueprint)
			{
				return Result;
			}
			Result->SetStringField(TEXT("blueprint"), Blueprint->GetPathName());
			Result->SetStringField(TEXT("blueprint_type"), StaticEnum<EBlueprintType>()->GetNameStringByValue(static_cast<int64>(Blueprint->BlueprintType)));
			Result->SetStringField(TEXT("parent_class"), Blueprint->ParentClass ? Blueprint->ParentClass->GetPathName() : FString());

			if (bIncludeGraphs)
			{
				TArray<TSharedPtr<FJsonValue>> Graphs;
				AppendGraphSummaries(Blueprint, false, Graphs);
				Result->SetArrayField(TEXT("graphs"), Graphs);
			}

			if (bIncludeFunctions)
			{
				TArray<TSharedPtr<FJsonValue>> Functions;
				for (UEdGraph* Graph : Blueprint->FunctionGraphs)
				{
					if (!Graph)
					{
						continue;
					}
					FJsonObjectPtr Summary = BuildFunctionSummary(Blueprint, Graph);
					TArray<TSharedPtr<FJsonValue>> CallSites;
					CollectFunctionCallSites(Blueprint, Graph, CallSites, nullptr);
					Summary->SetNumberField(TEXT("call_site_count"), CallSites.Num());
					Functions.Add(MakeShared<FJsonValueObject>(Summary));
				}
				Result->SetArrayField(TEXT("functions"), Functions);
			}

			if (bIncludeMacros)
			{
				TArray<TSharedPtr<FJsonValue>> Macros;
				for (UEdGraph* Graph : Blueprint->MacroGraphs)
				{
					if (!Graph)
					{
						continue;
					}
					Macros.Add(MakeShared<FJsonValueObject>(BuildMacroSummary(Blueprint, Graph, false)));
				}
				Result->SetArrayField(TEXT("macros"), Macros);
			}

			Result->SetObjectField(TEXT("construction_script"), BuildConstructionScriptSummary(Blueprint));

			if (bIncludeComponents && Blueprint->SimpleConstructionScript)
			{
				TArray<TSharedPtr<FJsonValue>> Components;
				for (USCS_Node* Node : Blueprint->SimpleConstructionScript->GetAllNodes())
				{
					if (!Node)
					{
						continue;
					}
					FJsonObjectPtr Component = MakeObject();
					Component->SetStringField(TEXT("name"), Node->GetVariableName().ToString());
					Component->SetStringField(TEXT("class"), Node->ComponentTemplate ? Node->ComponentTemplate->GetClass()->GetPathName() : FString());
					Components.Add(MakeShared<FJsonValueObject>(Component));
				}
				Result->SetArrayField(TEXT("components"), Components);
			}
			return Result;
		}

		int32 FindLocalVariableIndex(UK2Node_FunctionEntry* Entry, const FName& Name)
		{
			if (!Entry)
			{
				return INDEX_NONE;
			}
			for (int32 Index = 0; Index < Entry->LocalVariables.Num(); ++Index)
			{
				if (Entry->LocalVariables[Index].VarName == Name)
				{
					return Index;
				}
			}
			return INDEX_NONE;
		}

		void RenameLocalVariableReferences(UEdGraph* Graph, const FName& OldName, const FName& NewName)
		{
			if (!Graph)
			{
				return;
			}
			for (UEdGraphNode* Node : Graph->Nodes)
			{
				UK2Node_Variable* VariableNode = Cast<UK2Node_Variable>(Node);
				if (!VariableNode || VariableNode->GetVarName() != OldName)
				{
					continue;
				}
				VariableNode->Modify();
				VariableNode->VariableReference.SetMemberName(NewName);
				VariableNode->ReconstructNode();
			}
			for (UEdGraph* SubGraph : Graph->SubGraphs)
			{
				RenameLocalVariableReferences(SubGraph, OldName, NewName);
			}
		}

		int32 CountLocalVariableReferences(UEdGraph* Graph, const FName& Name)
		{
			if (!Graph)
			{
				return 0;
			}
			int32 Count = 0;
			for (UEdGraphNode* Node : Graph->Nodes)
			{
				if (UK2Node_Variable* VariableNode = Cast<UK2Node_Variable>(Node))
				{
					if (VariableNode->GetVarName() == Name)
					{
						++Count;
					}
				}
			}
			for (UEdGraph* SubGraph : Graph->SubGraphs)
			{
				Count += CountLocalVariableReferences(SubGraph, Name);
			}
			return Count;
		}

		void AttachCompileResult(UBlueprint* Blueprint, FJsonObjectPtr Result)
		{
			if (!Blueprint || !Result.IsValid())
			{
				return;
			}
			FJsonObjectPtr CompileResult;
			const bool bSuccess = CompileBlueprint(Blueprint, CompileResult);
			FJsonObjectPtr Compiled = MakeObject();
			Compiled->SetBoolField(TEXT("success"), bSuccess);
			double Errors = 0.0;
			double Warnings = 0.0;
			if (CompileResult.IsValid())
			{
				CompileResult->TryGetNumberField(TEXT("errors"), Errors);
				CompileResult->TryGetNumberField(TEXT("warnings"), Warnings);
			}
			Compiled->SetNumberField(TEXT("errors"), Errors);
			Compiled->SetNumberField(TEXT("warnings"), Warnings);
			Result->SetObjectField(TEXT("compile"), Compiled);
			Result->SetBoolField(TEXT("compiled"), true);
		}

		void AttachSignature(UBlueprint* Blueprint, UEdGraph* Graph, FJsonObjectPtr Result)
		{
			if (!Graph || !Result.IsValid())
			{
				return;
			}
			const bool bMacro = IsMacroGraph(Blueprint, Graph);
			if (bMacro)
			{
				Result->SetObjectField(TEXT("signature"), BuildMacroSummary(Blueprint, Graph, false));
			}
			else
			{
				Result->SetObjectField(TEXT("signature"), BuildFunctionSummary(Blueprint, Graph));
			}
		}

		void AttachGraphEnvelope(UBlueprint* Blueprint, FJsonObjectPtr Result)
		{
			if (!Blueprint || !Result.IsValid())
			{
				return;
			}
			FJsonObjectPtr Envelope = MakeGraphEnvelope(Blueprint);
			const TArray<TSharedPtr<FJsonValue>>* Graphs = nullptr;
			if (Envelope->TryGetArrayField(TEXT("graphs"), Graphs) && Graphs)
			{
				Result->SetArrayField(TEXT("graphs"), *Graphs);
			}
		}

		TSharedPtr<FJsonObject> MakeSignatureArgs(const FJsonObject& Args, const TCHAR* InputField, const TCHAR* OutputField)
		{
			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			for (const TPair<FString, TSharedPtr<FJsonValue>>& Pair : Args.Values)
			{
				Result->Values.Add(Pair.Key, Pair.Value);
			}
			if (const TArray<TSharedPtr<FJsonValue>>* Inputs = GetArray(Args, InputField))
			{
				Result->SetArrayField(TEXT("add_inputs"), *Inputs);
			}
			if (const TArray<TSharedPtr<FJsonValue>>* Outputs = GetArray(Args, OutputField))
			{
				Result->SetArrayField(TEXT("add_outputs"), *Outputs);
			}
			return Result;
		}

		void AttachAppliedEdits(const FSignatureEdits& Edits, FJsonObjectPtr Result)
		{
			FJsonObjectPtr Applied = MakeObject();
			Applied->SetArrayField(TEXT("added"), Edits.Added);
			Applied->SetArrayField(TEXT("removed"), Edits.Removed);
			Applied->SetArrayField(TEXT("renamed"), Edits.Renamed);
			Result->SetObjectField(TEXT("applied"), Applied);
			Result->SetArrayField(TEXT("orphaned_links"), Edits.OrphanedLinks);
			Result->SetArrayField(TEXT("warnings"), Edits.Warnings);
		}

		FJsonObjectPtr MakeMutationSuccess(UBlueprint* Blueprint)
		{
			FJsonObjectPtr Result = MakeSuccess();
			if (Blueprint)
			{
				Result->SetStringField(TEXT("blueprint"), Blueprint->GetPathName());
				AttachGraphEnvelope(Blueprint, Result);
			}
			return Result;
		}

		// --- reads ------------------------------------------------------------------

		FJsonObjectPtr OpListGraphs(const FJsonObject& Args)
		{
			FString Error;
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			const bool bIncludeSubGraphs = GetBool(Args, TEXT("include_subgraphs"), false);
			TArray<TSharedPtr<FJsonValue>> Graphs;
			AppendGraphSummaries(Blueprint, bIncludeSubGraphs, Graphs);
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetStringField(TEXT("blueprint"), Blueprint->GetPathName());
			Result->SetNumberField(TEXT("count"), Graphs.Num());
			Result->SetArrayField(TEXT("graphs"), Graphs);
			TArray<TSharedPtr<FJsonValue>> Warnings;
			if (Blueprint->BlueprintType == BPTYPE_MacroLibrary)
			{
				Warnings.Add(MakeShared<FJsonValueString>(TEXT("Macro libraries have no generated class and cannot contain function graphs.")));
			}
			Result->SetArrayField(TEXT("warnings"), Warnings);
			return Result;
		}

		FJsonObjectPtr OpInspectFunction(const FJsonObject& Args)
		{
			FString Error;
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			bool bNamed = false;
			UEdGraph* Graph = ResolveGraphArg(Blueprint, Args, bNamed, Error);
			if (!Graph)
			{
				if (bNamed)
				{
					const FString Requested = GetString(Args, TEXT("graph_id"), GetString(Args, TEXT("graph_name"), GetString(Args, TEXT("graph"))));
					return MakeGraphNotFoundError(Requested, Blueprint);
				}
				return MakeErrorObject(TEXT("graph_id or graph_name is required."));
			}
			if (!IsFunctionGraph(Blueprint, Graph))
			{
				return MakeCodedError(TEXT("not_a_function_graph"), FString::Printf(TEXT("Graph is not a function graph: %s"), *Graph->GetName()));
			}
			FJsonObjectPtr Result = BuildFunctionSummary(Blueprint, Graph);
			Result->SetBoolField(TEXT("success"), true);
			TArray<TSharedPtr<FJsonValue>> CallSites;
			CollectFunctionCallSites(Blueprint, Graph, CallSites, nullptr);
			Result->SetArrayField(TEXT("call_sites"), CallSites);
			Result->SetNumberField(TEXT("call_site_count"), CallSites.Num());
			TArray<TSharedPtr<FJsonValue>> Warnings;
			if (IsConstructionScriptGraph(Blueprint, Graph))
			{
				Warnings.Add(MakeShared<FJsonValueString>(TEXT("This graph is the Construction Script: it is bound to AActor::UserConstructionScript, takes no parameters, and its signature cannot be edited.")));
			}
			Result->SetArrayField(TEXT("warnings"), Warnings);
			return Result;
		}

		FJsonObjectPtr OpListMacros(const FJsonObject& Args)
		{
			FString Error;
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			const FString Query = GetString(Args, TEXT("query")).TrimStartAndEnd().ToLower();
			TArray<TSharedPtr<FJsonValue>> Macros;
			for (UEdGraph* Graph : Blueprint->MacroGraphs)
			{
				if (!Graph)
				{
					continue;
				}
				if (!Query.IsEmpty() && !Graph->GetName().ToLower().Contains(Query))
				{
					continue;
				}
				Macros.Add(MakeShared<FJsonValueObject>(BuildMacroSummary(Blueprint, Graph, true)));
			}
			TArray<TSharedPtr<FJsonValue>> Libraries;
			if (Blueprint->BlueprintType == BPTYPE_MacroLibrary)
			{
				Libraries.Add(MakeShared<FJsonValueString>(Blueprint->GetPathName()));
			}
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetStringField(TEXT("blueprint"), Blueprint->GetPathName());
			Result->SetNumberField(TEXT("count"), Macros.Num());
			Result->SetArrayField(TEXT("macros"), Macros);
			Result->SetArrayField(TEXT("libraries"), Libraries);
			return Result;
		}

		FJsonObjectPtr OpInspectMacro(const FJsonObject& Args)
		{
			FString Error;
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			bool bNamed = false;
			UEdGraph* Graph = ResolveGraphArg(Blueprint, Args, bNamed, Error);
			if (!Graph)
			{
				if (bNamed)
				{
					const FString Requested = GetString(Args, TEXT("graph_id"), GetString(Args, TEXT("graph_name"), GetString(Args, TEXT("graph"))));
					return MakeGraphNotFoundError(Requested, Blueprint);
				}
				return MakeErrorObject(TEXT("graph_id or graph_name is required."));
			}
			if (!IsMacroGraph(Blueprint, Graph))
			{
				return MakeCodedError(TEXT("not_a_macro_graph"), FString::Printf(TEXT("Graph is not a macro graph: %s"), *Graph->GetName()));
			}
			FJsonObjectPtr Result = BuildMacroSummary(Blueprint, Graph, true);
			Result->SetBoolField(TEXT("success"), true);
			TArray<TSharedPtr<FJsonValue>> Warnings;
			const TArray<TSharedPtr<FJsonValue>>* Instances = nullptr;
			if (Result->TryGetArrayField(TEXT("instances"), Instances) && Instances)
			{
				for (const TSharedPtr<FJsonValue>& Value : *Instances)
				{
					const TSharedPtr<FJsonObject> Instance = Value.IsValid() ? Value->AsObject() : nullptr;
					const TArray<TSharedPtr<FJsonValue>>* StalePins = nullptr;
					if (Instance.IsValid() && Instance->TryGetArrayField(TEXT("stale_pins"), StalePins) && StalePins && StalePins->Num() > 0)
					{
						Warnings.Add(MakeShared<FJsonValueString>(FString::Printf(
							TEXT("Macro instance has stale pins and needs a compile: %s (%s)"),
							*GetString(*Instance, TEXT("node_id")),
							*GetString(*Instance, TEXT("blueprint")))));
					}
				}
			}
			Result->SetArrayField(TEXT("warnings"), Warnings);
			return Result;
		}

		FJsonObjectPtr OpInspectConstructionScript(const FJsonObject& Args)
		{
			FString Error;
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			FJsonObjectPtr Result = BuildConstructionScriptSummary(Blueprint);
			Result->SetBoolField(TEXT("success"), true);
			Result->SetStringField(TEXT("blueprint"), Blueprint->GetPathName());
			if (!FBlueprintEditorUtils::SupportsConstructionScript(Blueprint))
			{
				const TArray<TSharedPtr<FJsonValue>>* Warnings = nullptr;
				TArray<TSharedPtr<FJsonValue>> UpdatedWarnings;
				if (Result->TryGetArrayField(TEXT("warnings"), Warnings) && Warnings)
				{
					UpdatedWarnings = *Warnings;
				}
				UpdatedWarnings.Add(MakeShared<FJsonValueString>(TEXT("This blueprint type does not support a Construction Script.")));
				Result->SetArrayField(TEXT("warnings"), UpdatedWarnings);
			}
			return Result;
		}

		FJsonObjectPtr OpInspectBlueprintModel(const FJsonObject& Args)
		{
			FString Error;
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			const bool bIncludeGraphs = GetBool(Args, TEXT("include_graphs"), true);
			const bool bIncludeFunctions = GetBool(Args, TEXT("include_functions"), true);
			const bool bIncludeMacros = GetBool(Args, TEXT("include_macros"), true);
			const bool bIncludeComponents = GetBool(Args, TEXT("include_components"), true);
			FJsonObjectPtr Result = BuildBlueprintModel(Blueprint, bIncludeGraphs, bIncludeFunctions, bIncludeMacros, bIncludeComponents);
			Result->SetBoolField(TEXT("success"), true);
			return Result;
		}

		// --- function mutations -----------------------------------------------------

		FJsonObjectPtr OpCreateFunction(const FJsonObject& Args)
		{
			FString Error;
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			FJsonObjectPtr Refusal;
			if (GuardGraphMutation(TEXT("create a function"), Refusal))
			{
				return Refusal;
			}
			if (Blueprint->BlueprintType == BPTYPE_MacroLibrary)
			{
				return MakeCodedError(
					TEXT("unsupported_blueprint_type"),
					TEXT("Macro libraries cannot contain function graphs. Create the function in a normal Blueprint, or use create_macro."));
			}
			const FString FunctionName = GetString(Args, TEXT("function_name"), GetString(Args, TEXT("name"))).TrimStartAndEnd();
			if (FunctionName.IsEmpty())
			{
				return MakeErrorObject(TEXT("function_name is required."));
			}
			const FString DuplicatePolicy = GetString(Args, TEXT("duplicate_policy"), TEXT("fail")).ToLower();
			if (UEdGraph* Existing = FindGraphByName(Blueprint, FunctionName))
			{
				if (DuplicatePolicy == TEXT("reuse"))
				{
					if (!IsFunctionGraph(Blueprint, Existing))
					{
						return MakeCodedError(TEXT("duplicate_graph_name"), FString::Printf(TEXT("A non-function graph already uses the name: %s"), *FunctionName));
					}
					FJsonObjectPtr Result = MakeMutationSuccess(Blueprint);
					Result->SetObjectField(TEXT("graph"), SerializeGraph(Existing, false));
					Result->SetObjectField(TEXT("signature"), BuildFunctionSummary(Blueprint, Existing));
					Result->SetBoolField(TEXT("reused"), true);
					return Result;
				}
				return MakeCodedError(TEXT("duplicate_function"), FString::Printf(TEXT("A graph named '%s' already exists. Pass duplicate_policy=reuse to target it."), *FunctionName));
			}

			Blueprint->Modify();
			UEdGraph* Graph = FBlueprintEditorUtils::CreateNewGraph(Blueprint, FName(*FunctionName), UEdGraph::StaticClass(), UEdGraphSchema_K2::StaticClass());
			if (!Graph)
			{
				return MakeErrorObject(TEXT("Could not create function graph."));
			}
			FBlueprintEditorUtils::AddFunctionGraph<UFunction>(Blueprint, Graph, true, nullptr);

			UK2Node_FunctionEntry* Entry = FindFunctionEntry(Graph);
			const bool bHasOutputs = GetArray(Args, TEXT("outputs")) && GetArray(Args, TEXT("outputs"))->Num() > 0;
			const bool bHasOutputsAdd = GetArray(Args, TEXT("add_outputs")) && GetArray(Args, TEXT("add_outputs"))->Num() > 0;
			if (Entry && (bHasOutputs || bHasOutputsAdd))
			{
				FBlueprintEditorUtils::FindOrCreateFunctionResultNode(Entry);
			}

			FSignatureEdits Edits;
			FJsonObjectPtr EditError;
			const TSharedPtr<FJsonObject> SignatureArgs = MakeSignatureArgs(Args, TEXT("inputs"), TEXT("outputs"));
			UK2Node_FunctionEntry* EntryPins = FindFunctionEntry(Graph);
			UK2Node_EditablePinBase* ExitPins = FindExitPins(Graph, false);
			if (!ApplySignatureEdits(EntryPins, ExitPins, *SignatureArgs, true, Edits, EditError))
			{
				FBlueprintEditorUtils::RemoveGraph(Blueprint, Graph, EGraphRemoveFlags::None);
				return EditError.IsValid() ? EditError : MakeErrorObject(TEXT("Could not apply the function signature."));
			}
			ApplyFunctionFlags(EntryPins, Args, Edits);
			ApplyFunctionMeta(EntryPins, Args);

			FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
			FJsonObjectPtr Result = MakeMutationSuccess(Blueprint);
			Result->SetObjectField(TEXT("graph"), SerializeGraph(Graph, false));
			AttachSignature(Blueprint, Graph, Result);
			AttachAppliedEdits(Edits, Result);
			if (GetBool(Args, TEXT("compile"), true))
			{
				AttachCompileResult(Blueprint, Result);
			}
			return Result;
		}

		FJsonObjectPtr OpSetFunctionSignature(const FJsonObject& Args)
		{
			FString Error;
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			bool bNamed = false;
			UEdGraph* Graph = ResolveGraphArg(Blueprint, Args, bNamed, Error);
			if (!Graph)
			{
				if (bNamed)
				{
					const FString Requested = GetString(Args, TEXT("graph_id"), GetString(Args, TEXT("graph_name"), GetString(Args, TEXT("graph"))));
					return MakeGraphNotFoundError(Requested, Blueprint);
				}
				return MakeErrorObject(TEXT("graph_id or graph_name is required."));
			}
			if (!IsFunctionGraph(Blueprint, Graph))
			{
				return MakeCodedError(TEXT("not_a_function_graph"), FString::Printf(TEXT("Graph is not a function graph: %s"), *Graph->GetName()));
			}
			const bool bConstructionScript = IsConstructionScriptGraph(Blueprint, Graph);
			const bool bWantsPinEdits = GetArray(Args, TEXT("add_inputs")) || GetArray(Args, TEXT("add_outputs"))
				|| GetArray(Args, TEXT("remove_pins")) || GetArray(Args, TEXT("rename_pins"));
			if (bConstructionScript && bWantsPinEdits)
			{
				return MakeCodedError(
					TEXT("construction_script_read_only"),
					TEXT("The Construction Script is bound to AActor::UserConstructionScript; its signature cannot be edited. Use add_node/reset_construction_script instead."));
			}
			FJsonObjectPtr Refusal;
			if (GuardGraphMutation(TEXT("edit a function signature"), Refusal))
			{
				return Refusal;
			}

			UK2Node_FunctionEntry* Entry = FindFunctionEntry(Graph);
			UK2Node_EditablePinBase* ExitPins = FindExitPins(Graph, false);
			const bool bHasOutputsRequest = GetArray(Args, TEXT("add_outputs")) && GetArray(Args, TEXT("add_outputs"))->Num() > 0;
			if (Entry && bHasOutputsRequest && !ExitPins)
			{
				ExitPins = FBlueprintEditorUtils::FindOrCreateFunctionResultNode(Entry);
			}

			Blueprint->Modify();
			Graph->Modify();
			if (Entry)
			{
				Entry->Modify();
			}
			if (ExitPins)
			{
				ExitPins->Modify();
			}

			FSignatureEdits Edits;
			FJsonObjectPtr EditError;
			if (!ApplySignatureEdits(Entry, ExitPins, Args, !bConstructionScript, Edits, EditError))
			{
				return EditError.IsValid() ? EditError : MakeErrorObject(TEXT("Could not apply the function signature."));
			}
			ApplyFunctionFlags(Entry, Args, Edits);
			ApplyFunctionMeta(Entry, Args);
			if (Edits.bChanged || Args.HasField(TEXT("flags")) || Args.HasField(TEXT("meta")))
			{
				FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
			}

			FJsonObjectPtr Result = MakeMutationSuccess(Blueprint);
			AttachSignature(Blueprint, Graph, Result);
			AttachAppliedEdits(Edits, Result);
			Result->SetArrayField(TEXT("stale_call_sites"), TArray<TSharedPtr<FJsonValue>>());
			if (Edits.bChanged)
			{
				TArray<TSharedPtr<FJsonValue>> CallSites;
				TArray<TSharedPtr<FJsonValue>> StaleSites;
				CollectFunctionCallSites(Blueprint, Graph, CallSites, &StaleSites);
				Result->SetArrayField(TEXT("call_sites"), CallSites);
				Result->SetArrayField(TEXT("stale_call_sites"), StaleSites);
			}
			if (GetBool(Args, TEXT("compile"), true))
			{
				AttachCompileResult(Blueprint, Result);
			}
			return Result;
		}

		FJsonObjectPtr OpRenameFunction(const FJsonObject& Args)
		{
			FString Error;
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			bool bNamed = false;
			UEdGraph* Graph = ResolveGraphArg(Blueprint, Args, bNamed, Error);
			if (!Graph)
			{
				if (bNamed)
				{
					const FString Requested = GetString(Args, TEXT("graph_id"), GetString(Args, TEXT("graph_name"), GetString(Args, TEXT("graph"))));
					return MakeGraphNotFoundError(Requested, Blueprint);
				}
				return MakeErrorObject(TEXT("graph_id or graph_name is required."));
			}
			if (!IsFunctionGraph(Blueprint, Graph))
			{
				return MakeCodedError(TEXT("not_a_function_graph"), FString::Printf(TEXT("Graph is not a function graph: %s"), *Graph->GetName()));
			}
			if (IsConstructionScriptGraph(Blueprint, Graph))
			{
				return MakeCodedError(TEXT("construction_script_read_only"), TEXT("The Construction Script cannot be renamed: it is bound to AActor::UserConstructionScript."));
			}
			const FString NewName = GetString(Args, TEXT("new_name"), GetString(Args, TEXT("function_name"))).TrimStartAndEnd();
			if (NewName.IsEmpty())
			{
				return MakeErrorObject(TEXT("new_name is required."));
			}
			const FString OldName = Graph->GetName();
			if (NewName.Equals(OldName, ESearchCase::CaseSensitive))
			{
				FJsonObjectPtr Result = MakeMutationSuccess(Blueprint);
				AttachSignature(Blueprint, Graph, Result);
				Result->SetBoolField(TEXT("renamed"), false);
				return Result;
			}
			if (UEdGraph* Collision = FindGraphByName(Blueprint, NewName))
			{
				if (Collision != Graph)
				{
					return MakeCodedError(TEXT("duplicate_function"), FString::Printf(TEXT("A graph named '%s' already exists."), *NewName));
				}
			}
			FJsonObjectPtr Refusal;
			if (GuardGraphMutation(TEXT("rename a function"), Refusal))
			{
				return Refusal;
			}

			TArray<TSharedPtr<FJsonValue>> CallSitesBefore;
			CollectFunctionCallSites(Blueprint, Graph, CallSitesBefore, nullptr);

			Blueprint->Modify();
			Graph->Modify();
			FBlueprintEditorUtils::RenameGraph(Graph, NewName);
			FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);

			TArray<TSharedPtr<FJsonValue>> CallSitesAfter;
			TArray<TSharedPtr<FJsonValue>> StaleSites;
			CollectFunctionCallSites(Blueprint, Graph, CallSitesAfter, &StaleSites);

			FJsonObjectPtr Result = MakeMutationSuccess(Blueprint);
			AttachSignature(Blueprint, Graph, Result);
			Result->SetBoolField(TEXT("renamed"), true);
			Result->SetStringField(TEXT("old_name"), OldName);
			Result->SetStringField(TEXT("new_name"), Graph->GetName());
			Result->SetArrayField(TEXT("rewritten_call_sites"), CallSitesAfter);
			Result->SetArrayField(TEXT("stale_call_sites"), StaleSites);
			Result->SetArrayField(TEXT("warnings"), TArray<TSharedPtr<FJsonValue>>());
			if (GetBool(Args, TEXT("compile"), true))
			{
				AttachCompileResult(Blueprint, Result);
			}
			return Result;
		}

		FJsonObjectPtr OpDeleteFunction(const FJsonObject& Args)
		{
			FString Error;
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			bool bNamed = false;
			UEdGraph* Graph = ResolveGraphArg(Blueprint, Args, bNamed, Error);
			if (!Graph)
			{
				if (bNamed)
				{
					const FString Requested = GetString(Args, TEXT("graph_id"), GetString(Args, TEXT("graph_name"), GetString(Args, TEXT("graph"))));
					return MakeGraphNotFoundError(Requested, Blueprint);
				}
				return MakeErrorObject(TEXT("graph_id or graph_name is required."));
			}
			if (!IsFunctionGraph(Blueprint, Graph))
			{
				return MakeCodedError(TEXT("not_a_function_graph"), FString::Printf(TEXT("Graph is not a function graph: %s"), *Graph->GetName()));
			}
			if (IsConstructionScriptGraph(Blueprint, Graph))
			{
				return MakeCodedError(TEXT("construction_script_read_only"), TEXT("The Construction Script cannot be deleted: it is bound to AActor::UserConstructionScript. Use reset_construction_script instead."));
			}
			FJsonObjectPtr Refusal;
			if (GuardGraphMutation(TEXT("delete a function"), Refusal))
			{
				return Refusal;
			}
			const FString DeletedName = Graph->GetName();

			TArray<TSharedPtr<FJsonValue>> CallSites;
			TArray<TSharedPtr<FJsonValue>> StaleSites;
			CollectFunctionCallSites(Blueprint, Graph, CallSites, &StaleSites);
			TArray<TSharedPtr<FJsonValue>> References;
			for (const TSharedPtr<FJsonValue>& Value : CallSites)
			{
				References.Add(Value);
			}
			for (const TSharedPtr<FJsonValue>& Value : StaleSites)
			{
				References.Add(Value);
			}

			Blueprint->Modify();
			FBlueprintEditorUtils::RemoveGraph(Blueprint, Graph, EGraphRemoveFlags::None);
			FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);

			FJsonObjectPtr Result = MakeMutationSuccess(Blueprint);
			Result->SetBoolField(TEXT("deleted"), true);
			Result->SetStringField(TEXT("deleted_name"), DeletedName);
			Result->SetArrayField(TEXT("rewritten_call_sites"), TArray<TSharedPtr<FJsonValue>>());
			Result->SetArrayField(TEXT("orphaned_references"), References);
			Result->SetArrayField(TEXT("warnings"), CallSites.Num() > 0
				? TArray<TSharedPtr<FJsonValue>>{ MakeShared<FJsonValueString>(FString::Printf(TEXT("%d call site(s) referenced the deleted function and now report errors until they are retargeted or deleted."), CallSites.Num())) }
				: TArray<TSharedPtr<FJsonValue>>());
			if (GetBool(Args, TEXT("compile"), true))
			{
				AttachCompileResult(Blueprint, Result);
			}
			return Result;
		}

		// --- local variables --------------------------------------------------------

		void ReconstructLocalVariableNodes(UEdGraph* Graph, const FName& VariableName)
		{
			if (!Graph)
			{
				return;
			}
			for (UEdGraphNode* Node : Graph->Nodes)
			{
				UK2Node_Variable* VariableNode = Cast<UK2Node_Variable>(Node);
				if (VariableNode && VariableNode->GetVarName() == VariableName)
				{
					VariableNode->ReconstructNode();
				}
			}
			for (UEdGraph* SubGraph : Graph->SubGraphs)
			{
				ReconstructLocalVariableNodes(SubGraph, VariableName);
			}
		}

		bool ValidateLocalVariableName(UBlueprint* Blueprint, UEdGraph* Graph, UK2Node_FunctionEntry* Entry, const FName& Name, FString& OutError, const FName& IgnoreName = NAME_None)
		{
			if (FindLocalVariableIndex(Entry, Name) != INDEX_NONE && Name != IgnoreName)
			{
				OutError = FString::Printf(TEXT("A local variable named '%s' already exists."), *Name.ToString());
				return false;
			}
			if (Entry && Name != IgnoreName)
			{
				for (UEdGraphPin* Pin : Entry->Pins)
				{
					if (Pin && Pin->PinName == Name)
					{
						OutError = FString::Printf(TEXT("The function already has a parameter named '%s'."), *Name.ToString());
						return false;
					}
				}
			}
			return true;
		}

		void ApplyLocalVariableOptions(FBPVariableDescription& Variable, const FJsonObject& Args)
		{
			const FString Category = GetString(Args, TEXT("category"));
			if (!Category.IsEmpty())
			{
				Variable.Category = FText::FromString(Category);
			}
			const FString DefaultValue = GetString(Args, TEXT("default_value"), GetString(Args, TEXT("default")));
			if (!DefaultValue.IsEmpty())
			{
				Variable.DefaultValue = DefaultValue;
			}
			const FJsonObjectPtr Flags = GetObject(Args, TEXT("flags"));
			if (Flags.IsValid())
			{
				uint64 PropertyFlags = Variable.PropertyFlags;
				auto ApplyFlag = [&](const FString& FlagField, uint64 FlagValue, bool bDefaultSet)
				{
					if (Flags->HasField(FlagField))
					{
						const bool bSet = Flags->GetBoolField(FlagField);
						PropertyFlags = bSet ? (PropertyFlags | FlagValue) : (PropertyFlags & ~FlagValue);
					}
					else if (bDefaultSet)
					{
						PropertyFlags |= FlagValue;
					}
				};
				ApplyFlag(TEXT("blueprint_visible"), CPF_BlueprintVisible, true);
				ApplyFlag(TEXT("editable"), CPF_Edit, false);
				if (Flags->HasField(TEXT("read_only")))
				{
					ApplyFlag(TEXT("read_only"), CPF_BlueprintReadOnly, false);
				}
				else
				{
					ApplyFlag(TEXT("private"), CPF_BlueprintReadOnly, false);
				}
				Variable.PropertyFlags = PropertyFlags;
			}
		}

		FJsonObjectPtr OpAddLocalVariable(const FJsonObject& Args)
		{
			FString Error;
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			bool bNamed = false;
			UEdGraph* Graph = ResolveGraphArg(Blueprint, Args, bNamed, Error);
			if (!Graph)
			{
				if (bNamed)
				{
					const FString Requested = GetString(Args, TEXT("graph_id"), GetString(Args, TEXT("graph_name"), GetString(Args, TEXT("graph"))));
					return MakeGraphNotFoundError(Requested, Blueprint);
				}
				return MakeErrorObject(TEXT("graph_id or graph_name is required."));
			}
			if (!IsFunctionGraph(Blueprint, Graph))
			{
				return MakeCodedError(TEXT("not_a_function_graph"), FString::Printf(TEXT("Local variables require a function graph: %s"), *Graph->GetName()));
			}
			UK2Node_FunctionEntry* Entry = FindFunctionEntry(Graph);
			if (!Entry)
			{
				return MakeCodedError(TEXT("not_a_function_graph"), TEXT("This function graph has no editable entry node."));
			}
			const FString VariableName = GetString(Args, TEXT("variable_name"), GetString(Args, TEXT("name"))).TrimStartAndEnd();
			if (VariableName.IsEmpty())
			{
				return MakeErrorObject(TEXT("variable_name is required."));
			}
			FEdGraphPinType PinType;
			if (!PinTypeFromArgs(Args, TEXT("pin_type"), TEXT("bool"), PinType, Error))
			{
				return MakeCodedError(TEXT("invalid_pin_type"), Error);
			}
			if (!ValidateLocalVariableName(Blueprint, Graph, Entry, FName(*VariableName), Error))
			{
				return MakeCodedError(TEXT("duplicate_local_variable"), Error);
			}
			FJsonObjectPtr Refusal;
			if (GuardGraphMutation(TEXT("add a local variable"), Refusal))
			{
				return Refusal;
			}
			const FString DefaultValue = GetString(Args, TEXT("default_value"), GetString(Args, TEXT("default")));

			Blueprint->Modify();
			Graph->Modify();
			if (!FBlueprintEditorUtils::AddLocalVariable(Blueprint, Graph, FName(*VariableName), PinType, DefaultValue))
			{
				return MakeErrorObject(FString::Printf(TEXT("Could not add local variable: %s"), *VariableName));
			}
			const int32 Index = FindLocalVariableIndex(Entry, FName(*VariableName));
			if (Index != INDEX_NONE)
			{
				ApplyLocalVariableOptions(Entry->LocalVariables[Index], Args);
			}
			Entry->RefreshFunctionVariableCache();
			FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);

			FJsonObjectPtr Result = MakeMutationSuccess(Blueprint);
			AttachSignature(Blueprint, Graph, Result);
			Result->SetObjectField(TEXT("local_variables"), SerializeLocalVariables(Entry));
			Result->SetStringField(TEXT("variable_name"), VariableName);
			if (GetBool(Args, TEXT("compile"), true))
			{
				AttachCompileResult(Blueprint, Result);
			}
			return Result;
		}

		FJsonObjectPtr OpUpdateLocalVariable(const FJsonObject& Args)
		{
			FString Error;
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			bool bNamed = false;
			UEdGraph* Graph = ResolveGraphArg(Blueprint, Args, bNamed, Error);
			if (!Graph)
			{
				if (bNamed)
				{
					const FString Requested = GetString(Args, TEXT("graph_id"), GetString(Args, TEXT("graph_name"), GetString(Args, TEXT("graph"))));
					return MakeGraphNotFoundError(Requested, Blueprint);
				}
				return MakeErrorObject(TEXT("graph_id or graph_name is required."));
			}
			if (!IsFunctionGraph(Blueprint, Graph))
			{
				return MakeCodedError(TEXT("not_a_function_graph"), FString::Printf(TEXT("Local variables require a function graph: %s"), *Graph->GetName()));
			}
			UK2Node_FunctionEntry* Entry = FindFunctionEntry(Graph);
			const FString VariableName = GetString(Args, TEXT("variable_name"), GetString(Args, TEXT("name"))).TrimStartAndEnd();
			if (VariableName.IsEmpty())
			{
				return MakeErrorObject(TEXT("variable_name is required."));
			}
			const int32 Index = FindLocalVariableIndex(Entry, FName(*VariableName));
			if (Index == INDEX_NONE)
			{
				return MakeCodedError(TEXT("local_variable_not_found"), FString::Printf(TEXT("Local variable not found: %s"), *VariableName));
			}
			const FString NewName = GetString(Args, TEXT("new_name")).TrimStartAndEnd();
			const bool bRename = !NewName.IsEmpty() && !NewName.Equals(VariableName, ESearchCase::CaseSensitive);
			const bool bRetype = Args.HasField(TEXT("pin_type")) || Args.HasField(TEXT("variable_type"));
			FEdGraphPinType NewType;
			if (bRetype && !PinTypeFromArgs(Args, TEXT("pin_type"), TEXT("bool"), NewType, Error))
			{
				return MakeCodedError(TEXT("invalid_pin_type"), Error);
			}
			if (bRename && !ValidateLocalVariableName(Blueprint, Graph, Entry, FName(*NewName), Error, FName(*VariableName)))
			{
				return MakeCodedError(TEXT("duplicate_local_variable"), Error);
			}
			const int32 ReferenceCount = CountLocalVariableReferences(Graph, FName(*VariableName));
			if (bRetype && ReferenceCount > 0 && !GetBool(Args, TEXT("force"), false))
			{
				TArray<TSharedPtr<FJsonValue>> Nodes;
				for (UEdGraphNode* Node : Graph->Nodes)
				{
					if (UK2Node_Variable* VariableNode = Cast<UK2Node_Variable>(Node))
					{
						if (VariableNode->GetVarName() == FName(*VariableName))
						{
							Nodes.Add(MakeShared<FJsonValueString>(NodeId(VariableNode)));
						}
					}
				}
				FJsonObjectPtr Failure = MakeCodedError(
					TEXT("local_variable_retype_requires_force"),
					FString::Printf(TEXT("Local variable '%s' is referenced by %d node(s); retyping rewrites those nodes. Pass force=true to proceed."), *VariableName, ReferenceCount));
				FJsonObjectPtr FailureError = Failure->GetObjectField(TEXT("error"));
				FailureError->SetArrayField(TEXT("referencing_nodes"), Nodes);
				return Failure;
			}
			FJsonObjectPtr Refusal;
			if (GuardGraphMutation(TEXT("update a local variable"), Refusal))
			{
				return Refusal;
			}

			Blueprint->Modify();
			Graph->Modify();
			Entry->Modify();
			FBPVariableDescription& Variable = Entry->LocalVariables[Index];
			if (bRename)
			{
				RenameLocalVariableReferences(Graph, FName(*VariableName), FName(*NewName));
				Variable.VarName = FName(*NewName);
				Variable.FriendlyName = NewName;
			}
			if (bRetype)
			{
				Variable.VarType = NewType;
			}
			ApplyLocalVariableOptions(Variable, Args);
			Entry->RefreshFunctionVariableCache();
			ReconstructLocalVariableNodes(Graph, Variable.VarName);
			FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);

			FJsonObjectPtr Result = MakeMutationSuccess(Blueprint);
			AttachSignature(Blueprint, Graph, Result);
			Result->SetObjectField(TEXT("local_variables"), SerializeLocalVariables(Entry));
			Result->SetNumberField(TEXT("referencing_nodes"), ReferenceCount);
			if (GetBool(Args, TEXT("compile"), true))
			{
				AttachCompileResult(Blueprint, Result);
			}
			return Result;
		}

		FJsonObjectPtr OpRemoveLocalVariable(const FJsonObject& Args)
		{
			FString Error;
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			bool bNamed = false;
			UEdGraph* Graph = ResolveGraphArg(Blueprint, Args, bNamed, Error);
			if (!Graph)
			{
				if (bNamed)
				{
					const FString Requested = GetString(Args, TEXT("graph_id"), GetString(Args, TEXT("graph_name"), GetString(Args, TEXT("graph"))));
					return MakeGraphNotFoundError(Requested, Blueprint);
				}
				return MakeErrorObject(TEXT("graph_id or graph_name is required."));
			}
			if (!IsFunctionGraph(Blueprint, Graph))
			{
				return MakeCodedError(TEXT("not_a_function_graph"), FString::Printf(TEXT("Local variables require a function graph: %s"), *Graph->GetName()));
			}
			UK2Node_FunctionEntry* Entry = FindFunctionEntry(Graph);
			const FString VariableName = GetString(Args, TEXT("variable_name"), GetString(Args, TEXT("name"))).TrimStartAndEnd();
			if (VariableName.IsEmpty())
			{
				return MakeErrorObject(TEXT("variable_name is required."));
			}
			const int32 Index = FindLocalVariableIndex(Entry, FName(*VariableName));
			if (Index == INDEX_NONE)
			{
				return MakeCodedError(TEXT("local_variable_not_found"), FString::Printf(TEXT("Local variable not found: %s"), *VariableName));
			}
			const int32 ReferenceCount = CountLocalVariableReferences(Graph, FName(*VariableName));
			TArray<TSharedPtr<FJsonValue>> ReferencingNodes;
			for (UEdGraphNode* Node : Graph->Nodes)
			{
				if (UK2Node_Variable* VariableNode = Cast<UK2Node_Variable>(Node))
				{
					if (VariableNode->GetVarName() == FName(*VariableName))
					{
						ReferencingNodes.Add(MakeShared<FJsonValueString>(NodeId(VariableNode)));
					}
				}
			}
			if (ReferenceCount > 0 && !GetBool(Args, TEXT("force"), false))
			{
				FJsonObjectPtr Failure = MakeCodedError(
					TEXT("local_variable_in_use"),
					FString::Printf(TEXT("Local variable '%s' is referenced by %d node(s). Pass force=true to delete those nodes as well."), *VariableName, ReferenceCount));
				FJsonObjectPtr FailureError = Failure->GetObjectField(TEXT("error"));
				FailureError->SetArrayField(TEXT("referencing_nodes"), ReferencingNodes);
				return Failure;
			}
			FJsonObjectPtr Refusal;
			if (GuardGraphMutation(TEXT("remove a local variable"), Refusal))
			{
				return Refusal;
			}

			Blueprint->Modify();
			Graph->Modify();
			Entry->Modify();
			Entry->LocalVariables.RemoveAt(Index);
			FBlueprintEditorUtils::RemoveVariableNodes(Blueprint, FName(*VariableName), true, Graph);
			Entry->RefreshFunctionVariableCache();
			FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);

			FJsonObjectPtr Result = MakeMutationSuccess(Blueprint);
			AttachSignature(Blueprint, Graph, Result);
			Result->SetObjectField(TEXT("local_variables"), SerializeLocalVariables(Entry));
			Result->SetArrayField(TEXT("removed_nodes"), ReferencingNodes);
			Result->SetNumberField(TEXT("referencing_nodes"), ReferenceCount);
			if (GetBool(Args, TEXT("compile"), true))
			{
				AttachCompileResult(Blueprint, Result);
			}
			return Result;
		}

		// --- macro authoring --------------------------------------------------------

		FJsonObjectPtr OpCreateMacroLibrary(const FJsonObject& Args)
		{
			const FString Name = GetString(Args, TEXT("macro_library_name"), GetString(Args, TEXT("name"))).TrimStartAndEnd();
			if (Name.IsEmpty())
			{
				return MakeErrorObject(TEXT("macro_library_name is required."));
			}
			FString Folder = GetString(Args, TEXT("path"), GetString(Args, TEXT("folder"), TEXT("/Game/"))).TrimStartAndEnd();
			if (Folder.IsEmpty())
			{
				Folder = TEXT("/Game/");
			}
			if (!Folder.StartsWith(TEXT("/")))
			{
				Folder = TEXT("/") + Folder;
			}
			if (!Folder.EndsWith(TEXT("/")))
			{
				Folder += TEXT("/");
			}
			const FString PackageName = Folder + Name;
			const FString ObjectPath = PackageName + TEXT(".") + Name;
			if (FindObject<UObject>(nullptr, *ObjectPath) || FindObject<UObject>(nullptr, *PackageName))
			{
				return MakeCodedError(TEXT("asset_already_exists"), FString::Printf(TEXT("An asset already exists at %s."), *PackageName));
			}
			if (FPackageName::DoesPackageExist(PackageName))
			{
				return MakeCodedError(TEXT("asset_already_exists"), FString::Printf(TEXT("A package already exists at %s."), *PackageName));
			}
			UClass* ParentClass = UObject::StaticClass();
			const FString ParentClassName = GetString(Args, TEXT("parent_class"));
			if (!ParentClassName.IsEmpty())
			{
				FString ParentError;
				ParentClass = ResolveClass(ParentClassName, UObject::StaticClass(), ParentError);
				if (!ParentClass)
				{
					return MakeCodedError(TEXT("invalid_parent_class"), ParentError);
				}
			}

			UPackage* Package = CreatePackage(nullptr, *PackageName);
			if (!Package)
			{
				return MakeErrorObject(FString::Printf(TEXT("Could not create package: %s"), *PackageName));
			}
			Package->Modify();
			UBlueprint* Blueprint = FKismetEditorUtilities::CreateBlueprint(
				ParentClass,
				Package,
				FName(*Name),
				BPTYPE_MacroLibrary,
				UBlueprint::StaticClass(),
				UBlueprintGeneratedClass::StaticClass(),
				FName(TEXT("UEVCreateMacroLibrary")));
			if (!Blueprint)
			{
				return MakeErrorObject(FString::Printf(TEXT("Could not create macro library: %s"), *PackageName));
			}
			FAssetRegistryModule::AssetCreated(Blueprint);
			Package->MarkPackageDirty();

			FJsonObjectPtr Result = MakeMutationSuccess(Blueprint);
			Result->SetStringField(TEXT("blueprint"), Blueprint->GetPathName());
			Result->SetStringField(TEXT("asset_path"), Blueprint->GetPathName());
			Result->SetBoolField(TEXT("created"), true);
			if (GetBool(Args, TEXT("save"), true))
			{
				FString SaveError;
				if (!SaveAsset(Blueprint, SaveError))
				{
					Result->SetBoolField(TEXT("success"), false);
					Result->SetStringField(TEXT("message"), SaveError);
					Result->SetBoolField(TEXT("saved"), false);
				}
				else
				{
					Result->SetBoolField(TEXT("saved"), true);
				}
			}
			return Result;
		}

		UBlueprint* LoadMacroLibrary(const FJsonObject& Args, FString& OutError)
		{
			const FString Library = GetString(Args, TEXT("macro_library"), GetString(Args, TEXT("library_path"), GetString(Args, TEXT("library_name"))));
			if (Library.IsEmpty())
			{
				OutError = TEXT("macro_library is required.");
				return nullptr;
			}
			TSharedPtr<FJsonObject> LibraryArgs = MakeShared<FJsonObject>();
			for (const TPair<FString, TSharedPtr<FJsonValue>>& Pair : Args.Values)
			{
				LibraryArgs->Values.Add(Pair.Key, Pair.Value);
			}
			LibraryArgs->SetStringField(TEXT("asset_path"), Library);
			LibraryArgs->SetStringField(TEXT("blueprint_name"), Library);
			UBlueprint* Blueprint = LoadBlueprint(*LibraryArgs, OutError);
			if (!Blueprint)
			{
				return nullptr;
			}
			if (Blueprint->BlueprintType != BPTYPE_MacroLibrary)
			{
				OutError = FString::Printf(TEXT("Asset is not a macro library (type %s): %s"),
					*StaticEnum<EBlueprintType>()->GetNameStringByValue(static_cast<int64>(Blueprint->BlueprintType)),
					*Blueprint->GetPathName());
				return nullptr;
			}
			return Blueprint;
		}

		FJsonObjectPtr OpCreateMacro(const FJsonObject& Args)
		{
			FString Error;
			UBlueprint* Blueprint = LoadMacroLibrary(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			FJsonObjectPtr Refusal;
			if (GuardGraphMutation(TEXT("create a macro"), Refusal))
			{
				return Refusal;
			}
			const FString MacroName = GetString(Args, TEXT("macro_name"), GetString(Args, TEXT("name"))).TrimStartAndEnd();
			if (MacroName.IsEmpty())
			{
				return MakeErrorObject(TEXT("macro_name is required."));
			}
			if (UEdGraph* Existing = FindGraphByName(Blueprint, MacroName))
			{
				return MakeCodedError(TEXT("duplicate_macro"), FString::Printf(TEXT("A graph named '%s' already exists in %s."), *MacroName, *Blueprint->GetName()));
			}
			Blueprint->Modify();
			UEdGraph* Graph = FBlueprintEditorUtils::CreateNewGraph(Blueprint, FName(*MacroName), UEdGraph::StaticClass(), UEdGraphSchema_K2::StaticClass());
			if (!Graph)
			{
				return MakeErrorObject(TEXT("Could not create macro graph."));
			}
			FBlueprintEditorUtils::AddMacroGraph(Blueprint, Graph, true, nullptr);

			UK2Node_Tunnel* EntryTunnel = FindMacroEntryTunnel(Graph);
			UK2Node_Tunnel* ExitTunnel = FindMacroExitTunnel(Graph);
			FSignatureEdits Edits;
			FJsonObjectPtr EditError;
			const TSharedPtr<FJsonObject> SignatureArgs = MakeSignatureArgs(Args, TEXT("inputs"), TEXT("outputs"));
			if (!ApplySignatureEdits(Cast<UK2Node_EditablePinBase>(EntryTunnel), Cast<UK2Node_EditablePinBase>(ExitTunnel), *SignatureArgs, true, Edits, EditError))
			{
				FBlueprintEditorUtils::RemoveGraph(Blueprint, Graph, EGraphRemoveFlags::None);
				return EditError.IsValid() ? EditError : MakeErrorObject(TEXT("Could not apply the macro signature."));
			}
			ApplyTunnelMeta(FindMacroEntryTunnel(Graph), FindMacroExitTunnel(Graph), Args);
			FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);

			FJsonObjectPtr Result = MakeMutationSuccess(Blueprint);
			Result->SetObjectField(TEXT("graph"), SerializeGraph(Graph, false));
			AttachSignature(Blueprint, Graph, Result);
			AttachAppliedEdits(Edits, Result);
			if (GetBool(Args, TEXT("compile"), true))
			{
				AttachCompileResult(Blueprint, Result);
			}
			return Result;
		}

		FJsonObjectPtr OpSetMacroSignature(const FJsonObject& Args)
		{
			FString Error;
			UBlueprint* Blueprint = LoadMacroLibrary(Args, Error);
			if (!Blueprint)
			{
				// Fall back to an inline macro graph when macro_library is omitted but the blueprint is a macro library itself.
				UBlueprint* Candidate = LoadBlueprint(Args, Error);
				if (!Candidate || Candidate->BlueprintType != BPTYPE_MacroLibrary)
				{
					return MakeErrorObject(Error);
				}
				Blueprint = Candidate;
			}
			bool bNamed = false;
			UEdGraph* Graph = ResolveGraphArg(Blueprint, Args, bNamed, Error);
			if (!Graph)
			{
				if (bNamed)
				{
					const FString Requested = GetString(Args, TEXT("graph_id"), GetString(Args, TEXT("graph_name"), GetString(Args, TEXT("graph"))));
					return MakeGraphNotFoundError(Requested, Blueprint);
				}
				return MakeErrorObject(TEXT("graph_id or graph_name is required."));
			}
			if (!IsMacroGraph(Blueprint, Graph))
			{
				return MakeCodedError(TEXT("not_a_macro_graph"), FString::Printf(TEXT("Graph is not a macro graph: %s"), *Graph->GetName()));
			}
			FJsonObjectPtr Refusal;
			if (GuardGraphMutation(TEXT("edit a macro signature"), Refusal))
			{
				return Refusal;
			}
			UK2Node_Tunnel* EntryTunnel = FindMacroEntryTunnel(Graph);
			UK2Node_Tunnel* ExitTunnel = FindMacroExitTunnel(Graph);
			Blueprint->Modify();
			Graph->Modify();
			if (EntryTunnel)
			{
				EntryTunnel->Modify();
			}
			if (ExitTunnel)
			{
				ExitTunnel->Modify();
			}
			FSignatureEdits Edits;
			FJsonObjectPtr EditError;
			if (!ApplySignatureEdits(Cast<UK2Node_EditablePinBase>(EntryTunnel), Cast<UK2Node_EditablePinBase>(ExitTunnel), Args, true, Edits, EditError))
			{
				return EditError.IsValid() ? EditError : MakeErrorObject(TEXT("Could not apply the macro signature."));
			}
			ApplyTunnelMeta(FindMacroEntryTunnel(Graph), FindMacroExitTunnel(Graph), Args);

			TArray<TSharedPtr<FJsonValue>> Instances;
			TArray<UK2Node_MacroInstance*> InstanceNodes;
			TArray<UBlueprint*> InstanceBlueprints;
			CollectMacroInstances(Graph, Instances, &InstanceNodes, &InstanceBlueprints);
			const bool bSyncInstances = GetBool(Args, TEXT("sync_instances"), true);
			if (bSyncInstances)
			{
				for (UK2Node_MacroInstance* Instance : InstanceNodes)
				{
					if (Instance)
					{
						Instance->Modify();
						Instance->ReconstructNode();
					}
				}
				for (UBlueprint* InstanceBlueprint : InstanceBlueprints)
				{
					if (InstanceBlueprint && InstanceBlueprint != Blueprint)
					{
						FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(InstanceBlueprint);
					}
				}
			}
			if (Edits.bChanged || Args.HasField(TEXT("meta")))
			{
				FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
			}

			FJsonObjectPtr Result = MakeMutationSuccess(Blueprint);
			AttachSignature(Blueprint, Graph, Result);
			AttachAppliedEdits(Edits, Result);
			Result->SetArrayField(TEXT("instances_resynced"), bSyncInstances ? Instances : TArray<TSharedPtr<FJsonValue>>());
			Result->SetArrayField(TEXT("instances"), Instances);
			Result->SetBoolField(TEXT("instances_synced"), bSyncInstances);
			{
				TArray<TSharedPtr<FJsonValue>> Affected;
				for (UBlueprint* InstanceBlueprint : InstanceBlueprints)
				{
					if (InstanceBlueprint && InstanceBlueprint != Blueprint)
					{
						Affected.Add(MakeShared<FJsonValueString>(InstanceBlueprint->GetPathName()));
					}
				}
				Result->SetArrayField(TEXT("affected_blueprints"), Affected);
			}
			if (GetBool(Args, TEXT("compile"), true))
			{
				AttachCompileResult(Blueprint, Result);
			}
			return Result;
		}

		FJsonObjectPtr OpRenameMacro(const FJsonObject& Args)
		{
			FString Error;
			UBlueprint* Blueprint = LoadMacroLibrary(Args, Error);
			if (!Blueprint)
			{
				UBlueprint* Candidate = LoadBlueprint(Args, Error);
				if (!Candidate || Candidate->BlueprintType != BPTYPE_MacroLibrary)
				{
					return MakeErrorObject(Error);
				}
				Blueprint = Candidate;
			}
			bool bNamed = false;
			UEdGraph* Graph = ResolveGraphArg(Blueprint, Args, bNamed, Error);
			if (!Graph)
			{
				if (bNamed)
				{
					const FString Requested = GetString(Args, TEXT("graph_id"), GetString(Args, TEXT("graph_name"), GetString(Args, TEXT("graph"))));
					return MakeGraphNotFoundError(Requested, Blueprint);
				}
				return MakeErrorObject(TEXT("graph_id or graph_name is required."));
			}
			if (!IsMacroGraph(Blueprint, Graph))
			{
				return MakeCodedError(TEXT("not_a_macro_graph"), FString::Printf(TEXT("Graph is not a macro graph: %s"), *Graph->GetName()));
			}
			const FString NewName = GetString(Args, TEXT("new_name"), GetString(Args, TEXT("macro_name"))).TrimStartAndEnd();
			if (NewName.IsEmpty())
			{
				return MakeErrorObject(TEXT("new_name is required."));
			}
			if (UEdGraph* Collision = FindGraphByName(Blueprint, NewName))
			{
				if (Collision != Graph)
				{
					return MakeCodedError(TEXT("duplicate_macro"), FString::Printf(TEXT("A graph named '%s' already exists."), *NewName));
				}
			}
			FJsonObjectPtr Refusal;
			if (GuardGraphMutation(TEXT("rename a macro"), Refusal))
			{
				return Refusal;
			}
			const FString OldName = Graph->GetName();
			Blueprint->Modify();
			Graph->Modify();
			FBlueprintEditorUtils::RenameGraph(Graph, NewName);

			TArray<TSharedPtr<FJsonValue>> Instances;
			TArray<UK2Node_MacroInstance*> InstanceNodes;
			TArray<UBlueprint*> RenameBlueprints;
			CollectMacroInstances(Graph, Instances, &InstanceNodes, &RenameBlueprints);
			for (UK2Node_MacroInstance* Instance : InstanceNodes)
			{
				if (Instance)
				{
					Instance->ReconstructNode();
				}
			}
			TArray<TSharedPtr<FJsonValue>> RenameAffected;
			for (UBlueprint* InstanceBlueprint : RenameBlueprints)
			{
				if (InstanceBlueprint)
				{
					FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(InstanceBlueprint);
					if (InstanceBlueprint != Blueprint)
					{
						RenameAffected.Add(MakeShared<FJsonValueString>(InstanceBlueprint->GetPathName()));
					}
				}
			}
			FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);

			FJsonObjectPtr Result = MakeMutationSuccess(Blueprint);
			AttachSignature(Blueprint, Graph, Result);
			Result->SetStringField(TEXT("old_name"), OldName);
			Result->SetStringField(TEXT("new_name"), Graph->GetName());
			Result->SetArrayField(TEXT("instances_resynced"), Instances);
			Result->SetArrayField(TEXT("affected_blueprints"), RenameAffected);
			if (GetBool(Args, TEXT("compile"), true))
			{
				AttachCompileResult(Blueprint, Result);
			}
			return Result;
		}

		FJsonObjectPtr OpDeleteMacro(const FJsonObject& Args)
		{
			FString Error;
			UBlueprint* Blueprint = LoadMacroLibrary(Args, Error);
			if (!Blueprint)
			{
				UBlueprint* Candidate = LoadBlueprint(Args, Error);
				if (!Candidate || Candidate->BlueprintType != BPTYPE_MacroLibrary)
				{
					return MakeErrorObject(Error);
				}
				Blueprint = Candidate;
			}
			bool bNamed = false;
			UEdGraph* Graph = ResolveGraphArg(Blueprint, Args, bNamed, Error);
			if (!Graph)
			{
				if (bNamed)
				{
					const FString Requested = GetString(Args, TEXT("graph_id"), GetString(Args, TEXT("graph_name"), GetString(Args, TEXT("graph"))));
					return MakeGraphNotFoundError(Requested, Blueprint);
				}
				return MakeErrorObject(TEXT("graph_id or graph_name is required."));
			}
			if (!IsMacroGraph(Blueprint, Graph))
			{
				return MakeCodedError(TEXT("not_a_macro_graph"), FString::Printf(TEXT("Graph is not a macro graph: %s"), *Graph->GetName()));
			}
			FJsonObjectPtr Refusal;
			if (GuardGraphMutation(TEXT("delete a macro"), Refusal))
			{
				return Refusal;
			}
			TArray<TSharedPtr<FJsonValue>> Instances;
			TArray<UK2Node_MacroInstance*> InstanceNodes;
			TArray<UBlueprint*> InstanceBlueprints;
			CollectMacroInstances(Graph, Instances, &InstanceNodes, &InstanceBlueprints);
			const FString DeletedName = Graph->GetName();
			Blueprint->Modify();

			// RemoveGraph only clears instances inside the macro library that owns the graph; instances in
			// other Blueprints have to be destroyed here, or they would keep a reference to a dead graph.
			for (UK2Node_MacroInstance* Instance : InstanceNodes)
			{
				if (!Instance)
				{
					continue;
				}
				UBlueprint* InstanceBlueprint = Instance->GetTypedOuter<UBlueprint>();
				if (InstanceBlueprint)
				{
					InstanceBlueprint->Modify();
				}
				FBlueprintEditorUtils::RemoveNode(InstanceBlueprint, Instance, /*bDontRecompile*/ true);
			}
			FBlueprintEditorUtils::RemoveGraph(Blueprint, Graph, EGraphRemoveFlags::None);
			for (UBlueprint* InstanceBlueprint : InstanceBlueprints)
			{
				if (InstanceBlueprint)
				{
					FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(InstanceBlueprint);
				}
			}
			FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);

			FJsonObjectPtr Result = MakeMutationSuccess(Blueprint);
			Result->SetBoolField(TEXT("deleted"), true);
			Result->SetStringField(TEXT("deleted_name"), DeletedName);
			Result->SetArrayField(TEXT("destroyed_instances"), Instances);
			{
				TArray<TSharedPtr<FJsonValue>> Affected;
				for (UBlueprint* InstanceBlueprint : InstanceBlueprints)
				{
					if (InstanceBlueprint && InstanceBlueprint != Blueprint)
					{
						Affected.Add(MakeShared<FJsonValueString>(InstanceBlueprint->GetPathName()));
					}
				}
				Result->SetArrayField(TEXT("affected_blueprints"), Affected);
			}
			Result->SetArrayField(TEXT("warnings"), Instances.Num() > 0
				? TArray<TSharedPtr<FJsonValue>>{ MakeShared<FJsonValueString>(FString::Printf(TEXT("%d macro instance node(s) were removed with the macro."), Instances.Num())) }
				: TArray<TSharedPtr<FJsonValue>>());
			if (GetBool(Args, TEXT("compile"), true))
			{
				AttachCompileResult(Blueprint, Result);
			}
			return Result;
		}

		// --- construction script ----------------------------------------------------

		FJsonObjectPtr OpResetConstructionScript(const FJsonObject& Args)
		{
			FString Error;
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			FJsonObjectPtr Refusal;
			if (GuardGraphMutation(TEXT("reset the Construction Script"), Refusal))
			{
				return Refusal;
			}
			if (!FBlueprintEditorUtils::SupportsConstructionScript(Blueprint))
			{
				return MakeCodedError(TEXT("unsupported_blueprint_type"), TEXT("This blueprint type does not support a Construction Script."));
			}
			UEdGraph* Graph = FBlueprintEditorUtils::FindUserConstructionScript(Blueprint);
			bool bCreated = false;
			if (!Graph)
			{
				Blueprint->Modify();
				UEdGraph* NewGraph = FBlueprintEditorUtils::CreateNewGraph(
					Blueprint,
					FName(*FString(TEXT("UserConstructionScript"))),
					UEdGraph::StaticClass(),
					UEdGraphSchema_K2::StaticClass());
				if (!NewGraph)
				{
					return MakeCodedError(TEXT("construction_script_not_found"), TEXT("This blueprint has no Construction Script and one could not be created."));
				}
				FBlueprintEditorUtils::AddFunctionGraph<UFunction>(Blueprint, NewGraph, false, nullptr);
				Graph = FBlueprintEditorUtils::FindUserConstructionScript(Blueprint);
				if (!Graph)
				{
					FBlueprintEditorUtils::RemoveGraph(Blueprint, NewGraph, EGraphRemoveFlags::None);
					return MakeCodedError(TEXT("construction_script_not_found"), TEXT("This blueprint has no Construction Script and one could not be created."));
				}
				FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
				bCreated = true;
			}
			const bool bKeepParentCall = GetBool(Args, TEXT("keep_parent_call"), true);
			TArray<UEdGraphNode*> Doomed;
			UK2Node_FunctionEntry* Entry = FindFunctionEntry(Graph);
			UK2Node_FunctionResult* ResultNode = FindFunctionResult(Graph);
			for (UEdGraphNode* Node : Graph->Nodes)
			{
				if (!Node || Node == Entry || Node == ResultNode)
				{
					continue;
				}
				if (bKeepParentCall && Cast<UK2Node_CallParentFunction>(Node))
				{
					continue;
				}
				Doomed.Add(Node);
			}
			TArray<TSharedPtr<FJsonValue>> RemovedNodeIds;
			Blueprint->Modify();
			Graph->Modify();
			for (UEdGraphNode* Node : Doomed)
			{
				RemovedNodeIds.Add(MakeShared<FJsonValueString>(NodeId(Node)));
				FBlueprintEditorUtils::RemoveNode(Blueprint, Node, true);
			}
			if (Entry)
			{
				Entry->RefreshFunctionVariableCache();
			}
			FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);

			FJsonObjectPtr Result = MakeMutationSuccess(Blueprint);
			Result->SetBoolField(TEXT("created"), bCreated);
			Result->SetArrayField(TEXT("removed_node_ids"), RemovedNodeIds);
			Result->SetObjectField(TEXT("construction_script"), BuildConstructionScriptSummary(Blueprint));
			if (GetBool(Args, TEXT("compile"), true))
			{
				AttachCompileResult(Blueprint, Result);
			}
			return Result;
		}

		// --- verification -----------------------------------------------------------

		void AddDifference(TArray<TSharedPtr<FJsonValue>>& Differences, const FString& Path, const FString& Expected, const FString& Actual)
		{
			FJsonObjectPtr Difference = MakeObject();
			Difference->SetStringField(TEXT("path"), Path);
			Difference->SetStringField(TEXT("expected"), Expected);
			Difference->SetStringField(TEXT("actual"), Actual);
			Differences.Add(MakeShared<FJsonValueObject>(Difference));
		}

		FString DescribePinList(UK2Node_EditablePinBase* Node, EEdGraphPinDirection Direction)
		{
			TArray<FString> Parts;
			if (Node)
			{
				for (UEdGraphPin* Pin : Node->Pins)
				{
					if (Pin && Pin->Direction == Direction && !Pin->bHidden && Pin->PinType.PinCategory != UEdGraphSchema_K2::PC_Exec)
					{
						Parts.Add(FString::Printf(TEXT("%s:%s"), *Pin->PinName.ToString(), *SerializePinTypeField(Pin->PinType)));
					}
				}
			}
			Parts.Sort();
			return FString::Join(Parts, TEXT(","));
		}

		FString DescribeExpectedPins(const TArray<TSharedPtr<FJsonValue>>& Pins)
		{
			TArray<FString> Parts;
			for (const TSharedPtr<FJsonValue>& Value : Pins)
			{
				if (!Value.IsValid())
				{
					continue;
				}
				if (Value->Type == EJson::String)
				{
					Parts.Add(Value->AsString());
					continue;
				}
				const TSharedPtr<FJsonObject> PinObject = Value->AsObject();
				if (!PinObject.IsValid())
				{
					continue;
				}
				const FString PinName = GetString(*PinObject, TEXT("name"), GetString(*PinObject, TEXT("pin_name")));
				const FString PinType = GetString(*PinObject, TEXT("type"), GetString(*PinObject, TEXT("pin_type")));
				Parts.Add(PinType.IsEmpty() ? PinName : FString::Printf(TEXT("%s:%s"), *PinName, *PinType.ToLower()));
			}
			Parts.Sort();
			return FString::Join(Parts, TEXT(","));
		}

		FJsonObjectPtr OpVerifyBlueprint(const FJsonObject& Args)
		{
			FString Error;
			UBlueprint* Blueprint = LoadBlueprint(Args, Error);
			if (!Blueprint)
			{
				return MakeErrorObject(Error);
			}
			TArray<TSharedPtr<FJsonValue>> Differences;
			TArray<TSharedPtr<FJsonValue>> Warnings;

			TArray<UEdGraph*> AllGraphs;
			AppendGraphs(Blueprint, AllGraphs, true);
			TSet<FString> ActualGraphNames;
			for (UEdGraph* Graph : AllGraphs)
			{
				if (Graph)
				{
					ActualGraphNames.Add(Graph->GetName());
				}
			}

			const FJsonObjectPtr Expected = GetObject(Args, TEXT("expected"));
			if (Expected.IsValid())
			{
				const TArray<TSharedPtr<FJsonValue>>* ExpectedGraphs = nullptr;
				if (Expected->TryGetArrayField(TEXT("graphs"), ExpectedGraphs) && ExpectedGraphs)
				{
					for (const TSharedPtr<FJsonValue>& Value : *ExpectedGraphs)
					{
						FString Name;
						if (Value.IsValid() && Value->Type == EJson::String)
						{
							Name = Value->AsString();
						}
						else if (Value.IsValid() && Value->Type == EJson::Object)
						{
							Name = GetString(*Value->AsObject(), TEXT("name"), GetString(*Value->AsObject(), TEXT("graph_name")));
						}
						if (Name.IsEmpty())
						{
							continue;
						}
						if (!ActualGraphNames.Contains(Name))
						{
							AddDifference(Differences, FString::Printf(TEXT("graphs.%s"), *Name), TEXT("present"), TEXT("missing"));
						}
					}
				}

				const TArray<TSharedPtr<FJsonValue>>* ExpectedFunctions = nullptr;
				if (Expected->TryGetArrayField(TEXT("functions"), ExpectedFunctions) && ExpectedFunctions)
				{
					for (const TSharedPtr<FJsonValue>& Value : *ExpectedFunctions)
					{
						const TSharedPtr<FJsonObject> FunctionObject = Value.IsValid() ? Value->AsObject() : nullptr;
						if (!FunctionObject.IsValid())
						{
							continue;
						}
						const FString Name = GetString(*FunctionObject, TEXT("name"), GetString(*FunctionObject, TEXT("function_name")));
						if (Name.IsEmpty())
						{
							continue;
						}
						UEdGraph* Graph = FindGraphByName(Blueprint, Name);
						if (!Graph || !IsFunctionGraph(Blueprint, Graph))
						{
							AddDifference(Differences, FString::Printf(TEXT("functions.%s"), *Name), TEXT("present"), TEXT("missing"));
							continue;
						}
						UK2Node_FunctionEntry* Entry = FindFunctionEntry(Graph);
						const TArray<TSharedPtr<FJsonValue>>* ExpectedPins = nullptr;
						if (FunctionObject->TryGetArrayField(TEXT("pins"), ExpectedPins) && ExpectedPins)
						{
							const FString ExpectedPinsText = DescribeExpectedPins(*ExpectedPins);
							TArray<FString> ActualParts;
							DescribePinList(Entry, EGPD_Output).ParseIntoArray(ActualParts, TEXT(","), false);
							DescribePinList(FindExitPins(Graph, false), EGPD_Input).ParseIntoArray(ActualParts, TEXT(","), false);
							ActualParts.Sort();
							const FString ActualPinsText = FString::Join(ActualParts, TEXT(","));
							if (ExpectedPinsText != ActualPinsText)
							{
								AddDifference(Differences, FString::Printf(TEXT("functions.%s.pins"), *Name), ExpectedPinsText, ActualPinsText);
							}
						}
						const TArray<TSharedPtr<FJsonValue>>* ExpectedLocals = nullptr;
						if (FunctionObject->TryGetArrayField(TEXT("locals"), ExpectedLocals) && ExpectedLocals)
						{
							TArray<FString> ActualLocals;
							if (Entry)
							{
								for (const FBPVariableDescription& Variable : Entry->LocalVariables)
								{
									ActualLocals.Add(Variable.VarName.ToString());
								}
							}
							ActualLocals.Sort();
							TArray<FString> WantedLocals;
							for (const TSharedPtr<FJsonValue>& LocalValue : *ExpectedLocals)
							{
								if (LocalValue.IsValid() && LocalValue->Type == EJson::String)
								{
									WantedLocals.Add(LocalValue->AsString());
								}
							}
							WantedLocals.Sort();
							const FString ActualText = FString::Join(ActualLocals, TEXT(","));
							const FString WantedText = FString::Join(WantedLocals, TEXT(","));
							if (ActualText != WantedText)
							{
								AddDifference(Differences, FString::Printf(TEXT("functions.%s.locals"), *Name), WantedText, ActualText);
							}
						}
					}
				}

				const TArray<TSharedPtr<FJsonValue>>* ExpectedMacros = nullptr;
				if (Expected->TryGetArrayField(TEXT("macros"), ExpectedMacros) && ExpectedMacros)
				{
					TSet<FString> ActualMacros;
					for (UEdGraph* Graph : Blueprint->MacroGraphs)
					{
						if (Graph)
						{
							ActualMacros.Add(Graph->GetName());
						}
					}
					for (const TSharedPtr<FJsonValue>& Value : *ExpectedMacros)
					{
						FString Name;
						if (Value.IsValid() && Value->Type == EJson::String)
						{
							Name = Value->AsString();
						}
						else if (Value.IsValid() && Value->Type == EJson::Object)
						{
							Name = GetString(*Value->AsObject(), TEXT("name"), GetString(*Value->AsObject(), TEXT("macro_name")));
						}
						if (!Name.IsEmpty() && !ActualMacros.Contains(Name))
						{
							AddDifference(Differences, FString::Printf(TEXT("macros.%s"), *Name), TEXT("present"), TEXT("missing"));
						}
					}
				}

				bool bExpectedUcs = false;
				if (Expected->TryGetBoolField(TEXT("construction_script"), bExpectedUcs))
				{
					const bool bActualUcs = FBlueprintEditorUtils::FindUserConstructionScript(Blueprint) != nullptr;
					if (bExpectedUcs != bActualUcs)
					{
						AddDifference(Differences, TEXT("construction_script"), bExpectedUcs ? TEXT("true") : TEXT("false"), bActualUcs ? TEXT("true") : TEXT("false"));
					}
				}
			}

			FJsonObjectPtr Result = MakeSuccess();
			Result->SetStringField(TEXT("blueprint"), Blueprint->GetPathName());
			Result->SetBoolField(TEXT("match"), Differences.Num() == 0);
			Result->SetArrayField(TEXT("differences"), Differences);
			Result->SetObjectField(TEXT("model"), BuildBlueprintModel(Blueprint, true, true, true, true));
			const bool bCompileRequested = GetBool(Args, TEXT("compile"), true);
			int32 PieWorldCount = 0;
			if (bCompileRequested && IsPlayInEditorActive(PieWorldCount))
			{
				Warnings.Add(MakeShared<FJsonValueString>(FString::Printf(TEXT("Skipped compile: Play In Editor is running (%d world(s)). Stop PIE and call verify_blueprint again to compile."), PieWorldCount)));
				Result->SetBoolField(TEXT("compiled"), false);
				Result->SetBoolField(TEXT("compile_skipped"), true);
			}
			else if (bCompileRequested)
			{
				AttachCompileResult(Blueprint, Result);
			}
			Result->SetArrayField(TEXT("warnings"), Warnings);
			return Result;
		}

	} // namespace

	FJsonObjectPtr HandleBlueprintDepthOperation(const FString& Operation, const FJsonObject& Args)
	{
		if (Operation == TEXT("list_graphs"))
		{
			return OpListGraphs(Args);
		}
		if (Operation == TEXT("inspect_function"))
		{
			return OpInspectFunction(Args);
		}
		if (Operation == TEXT("list_macros"))
		{
			return OpListMacros(Args);
		}
		if (Operation == TEXT("inspect_macro"))
		{
			return OpInspectMacro(Args);
		}
		if (Operation == TEXT("inspect_construction_script"))
		{
			return OpInspectConstructionScript(Args);
		}
		if (Operation == TEXT("inspect_blueprint_model"))
		{
			return OpInspectBlueprintModel(Args);
		}
		if (Operation == TEXT("create_function"))
		{
			return OpCreateFunction(Args);
		}
		if (Operation == TEXT("set_function_signature"))
		{
			return OpSetFunctionSignature(Args);
		}
		if (Operation == TEXT("rename_function"))
		{
			return OpRenameFunction(Args);
		}
		if (Operation == TEXT("delete_function"))
		{
			return OpDeleteFunction(Args);
		}
		if (Operation == TEXT("add_local_variable"))
		{
			return OpAddLocalVariable(Args);
		}
		if (Operation == TEXT("update_local_variable"))
		{
			return OpUpdateLocalVariable(Args);
		}
		if (Operation == TEXT("remove_local_variable"))
		{
			return OpRemoveLocalVariable(Args);
		}
		if (Operation == TEXT("create_macro_library"))
		{
			return OpCreateMacroLibrary(Args);
		}
		if (Operation == TEXT("create_macro"))
		{
			return OpCreateMacro(Args);
		}
		if (Operation == TEXT("set_macro_signature"))
		{
			return OpSetMacroSignature(Args);
		}
		if (Operation == TEXT("rename_macro"))
		{
			return OpRenameMacro(Args);
		}
		if (Operation == TEXT("delete_macro"))
		{
			return OpDeleteMacro(Args);
		}
		if (Operation == TEXT("reset_construction_script"))
		{
			return OpResetConstructionScript(Args);
		}
		if (Operation == TEXT("verify_blueprint"))
		{
			return OpVerifyBlueprint(Args);
		}
		return nullptr;
	}

	// Local-variable helpers stay file-local; expose nothing else from this translation unit.
} // namespace UEVGraph
