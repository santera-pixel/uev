#include "UEVLibrary.h"

#include "CoreGlobals.h"
#include "Dom/JsonObject.h"
#include "Editor.h"
#include "HAL/IConsoleManager.h"
#include "Interfaces/IPluginManager.h"
#include "Modules/ModuleManager.h"
#include "ScopedTransaction.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

namespace
{
	TUniquePtr<FScopedTransaction> GActiveTransaction;
	// Weak references: retained handles must never keep an object alive by
	// itself. Rooting an actor here made a later destroy trip the engine
	// assertion !IsRooted() in UObjectBaseUtility.h:173 (crash seen in 1.6.0
	// testing), and a hard pointer dangles after garbage collection.
	TArray<TWeakObjectPtr<UObject>> GRetainedObjects;

	struct FScopedUnattendedOverride
	{
		FScopedUnattendedOverride()
			: bPrevious(GIsRunningUnattendedScript)
		{
			GIsRunningUnattendedScript = false;
		}

		~FScopedUnattendedOverride()
		{
			GIsRunningUnattendedScript = bPrevious;
		}

		bool bPrevious;
	};
}

bool UUEVLibrary::BeginTransaction(const FString& Label)
{
	if (!GEditor)
	{
		return false;
	}

	GActiveTransaction.Reset();
	if (GEditor->IsTransactionActive())
	{
		GEditor->EndTransaction();
	}

	FScopedUnattendedOverride UnattendedOverride;
	GActiveTransaction = MakeUnique<FScopedTransaction>(FText::FromString(Label));
	return GActiveTransaction.IsValid();
}

bool UUEVLibrary::EndTransaction()
{
	if (!GActiveTransaction.IsValid())
	{
		return false;
	}

	GActiveTransaction.Reset();
	return true;
}

bool UUEVLibrary::CancelTransaction()
{
	if (!GActiveTransaction.IsValid())
	{
		return false;
	}

	GActiveTransaction->Cancel();
	GActiveTransaction.Reset();
	return true;
}

bool UUEVLibrary::Undo()
{
	if (!GEditor)
	{
		return false;
	}

	FScopedUnattendedOverride UnattendedOverride;
	return GEditor->UndoTransaction();
}

bool UUEVLibrary::Redo()
{
	if (!GEditor)
	{
		return false;
	}

	FScopedUnattendedOverride UnattendedOverride;
	return GEditor->RedoTransaction();
}

FString UUEVLibrary::GetConsoleVariableInfo(const FString& Name)
{
	const FString NormalizedName = Name.TrimStartAndEnd();
	IConsoleVariable* Variable = NormalizedName.IsEmpty()
		? nullptr
		: IConsoleManager::Get().FindConsoleVariable(*NormalizedName, false);

	TSharedRef<FJsonObject> Info = MakeShared<FJsonObject>();
	Info->SetStringField(TEXT("name"), NormalizedName);
	Info->SetBoolField(TEXT("available"), Variable != nullptr);

	if (Variable)
	{
		Info->SetStringField(TEXT("string_value"), Variable->GetString());
		Info->SetNumberField(TEXT("int_value"), Variable->GetInt());
		Info->SetNumberField(TEXT("float_value"), Variable->GetFloat());
		Info->SetBoolField(TEXT("bool_value"), Variable->GetBool());
		Info->SetStringField(TEXT("help"), Variable->GetHelp());
	}

	FString Output;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
	FJsonSerializer::Serialize(Info, Writer);
	return Output;
}

TArray<FString> UUEVLibrary::GetEnabledPluginNames()
{
	TArray<FString> Names;
	for (const TSharedRef<IPlugin>& Plugin : IPluginManager::Get().GetEnabledPlugins())
	{
		Names.Add(Plugin->GetName());
	}
	return Names;
}

bool UUEVLibrary::IsModuleLoaded(const FString& ModuleName)
{
	return !ModuleName.IsEmpty() && FModuleManager::Get().IsModuleLoaded(FName(*ModuleName));
}

int32 UUEVLibrary::RetainObject(UObject* Object)
{
	if (!IsValid(Object))
	{
		return INDEX_NONE;
	}

	for (int32 Index = 0; Index < GRetainedObjects.Num(); ++Index)
	{
		if (GRetainedObjects[Index].Get() == Object)
		{
			return Index;
		}
	}

	// Drop entries whose object went away so the table does not grow forever.
	for (int32 Index = GRetainedObjects.Num() - 1; Index >= 0; --Index)
	{
		if (!GRetainedObjects[Index].IsValid())
		{
			GRetainedObjects.RemoveAtSwap(Index, 1, false);
		}
	}

	GRetainedObjects.Add(Object);
	return GRetainedObjects.Num() - 1;
}

bool UUEVLibrary::ReleaseObject(UObject* Object)
{
	if (!Object)
	{
		return false;
	}

	const int32 Before = GRetainedObjects.Num();
	for (int32 Index = GRetainedObjects.Num() - 1; Index >= 0; --Index)
	{
		if (GRetainedObjects[Index].Get() == Object)
		{
			GRetainedObjects.RemoveAtSwap(Index, 1, false);
		}
	}

	return GRetainedObjects.Num() < Before;
}

void UUEVLibrary::ReleaseAllRetainedObjects()
{
	GRetainedObjects.Empty();
}

int32 UUEVLibrary::GetRetainedObjectCount()
{
	return GRetainedObjects.Num();
}

UObject* UUEVLibrary::GetRetainedObject(int32 Index)
{
	return GRetainedObjects.IsValidIndex(Index) ? GRetainedObjects[Index].Get() : nullptr;
}
