#include "UEVGraphLibrary.h"

#include "UEVGraphShared.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"

namespace
{
	UWorld* FindPieWorld()
	{
		if (!GEngine)
		{
			return nullptr;
		}
		for (const FWorldContext& Context : GEngine->GetWorldContexts())
		{
			if (Context.WorldType == EWorldType::PIE && Context.World())
			{
				return Context.World();
			}
		}
		return nullptr;
	}

	FVector ReadLocation(const FJsonObject& Args)
	{
		const TArray<TSharedPtr<FJsonValue>>* Values = UEVGraph::GetArray(Args, TEXT("location"));
		if (Values && Values->Num() >= 3)
		{
			return FVector((*Values)[0]->AsNumber(), (*Values)[1]->AsNumber(), (*Values)[2]->AsNumber());
		}
		const TSharedPtr<FJsonObject> Object = UEVGraph::GetObject(Args, TEXT("location"));
		if (Object.IsValid())
		{
			return FVector(UEVGraph::GetNumber(*Object, TEXT("x")), UEVGraph::GetNumber(*Object, TEXT("y")), UEVGraph::GetNumber(*Object, TEXT("z")));
		}
		return FVector(0.0, 0.0, 0.0);
	}

	UEVGraph::FJsonObjectPtr HandleGameplayOperation(const FString& Operation, const FJsonObject& Args)
	{
		if (Operation != TEXT("spawn_pie_actor"))
		{
			return UEVGraph::MakeErrorObject(FString::Printf(TEXT("Unknown gameplay operation: %s"), *Operation));
		}

		UWorld* World = FindPieWorld();
		if (!World)
		{
			return UEVGraph::MakeErrorObject(TEXT("Play-In-Editor is not running; no PIE world is available to spawn into."));
		}

		const FString ClassPath = UEVGraph::GetString(Args, TEXT("class_path"));
		if (ClassPath.IsEmpty())
		{
			return UEVGraph::MakeErrorObject(TEXT("class_path is required."));
		}
		UClass* ActorClass = LoadObject<UClass>(nullptr, *ClassPath);
		if (!ActorClass)
		{
			return UEVGraph::MakeErrorObject(FString::Printf(TEXT("Could not load class: %s"), *ClassPath));
		}
		if (!ActorClass->IsChildOf(AActor::StaticClass()))
		{
			return UEVGraph::MakeErrorObject(FString::Printf(TEXT("%s is not an actor class."), *ClassPath));
		}

		FActorSpawnParameters SpawnParams;
		SpawnParams.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
		AActor* Actor = World->SpawnActor<AActor>(ActorClass, ReadLocation(Args), FRotator::ZeroRotator, SpawnParams);
		if (!Actor)
		{
			return UEVGraph::MakeErrorObject(TEXT("SpawnActor returned null."));
		}

		const FString Label = UEVGraph::GetString(Args, TEXT("label"));
		if (!Label.IsEmpty())
		{
			Actor->SetActorLabel(Label);
		}

		UEVGraph::FJsonObjectPtr Result = UEVGraph::MakeSuccess();
		Result->SetStringField(TEXT("actor_name"), Actor->GetName());
		Result->SetStringField(TEXT("actor_label"), Actor->GetActorLabel());
		Result->SetStringField(TEXT("class"), ActorClass->GetName());
		const FVector Location = Actor->GetActorLocation();
		TArray<TSharedPtr<FJsonValue>> LocationArray;
		LocationArray.Add(MakeShared<FJsonValueNumber>(Location.X));
		LocationArray.Add(MakeShared<FJsonValueNumber>(Location.Y));
		LocationArray.Add(MakeShared<FJsonValueNumber>(Location.Z));
		Result->SetArrayField(TEXT("location"), LocationArray);
		return Result;
	}
}

FString UUEVGraphLibrary::ExecuteGraphOperation(const FString& Operation, const FString& ArgsJson)
{
	TSharedPtr<FJsonObject> Args;
	if (!ArgsJson.IsEmpty())
	{
		const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(ArgsJson);
		if (!FJsonSerializer::Deserialize(Reader, Args) || !Args.IsValid())
		{
			return UEVGraph::Serialize(UEVGraph::MakeErrorObject(TEXT("Could not parse graph arguments JSON.")));
		}
	}
	if (!Args.IsValid())
	{
		Args = UEVGraph::MakeObject();
	}

	const FString Normalized = Operation.TrimStartAndEnd().ToLower();
	UEVGraph::FJsonObjectPtr Result;
	if (Normalized.StartsWith(TEXT("blueprint.")))
	{
		Result = UEVGraph::HandleBlueprintOperation(Normalized.RightChop(10), *Args);
	}
	else if (Normalized.StartsWith(TEXT("material.")))
	{
		Result = UEVGraph::HandleMaterialOperation(Normalized.RightChop(9), *Args);
	}
	else if (Normalized.StartsWith(TEXT("animation.")))
	{
		Result = UEVGraph::HandleAnimationOperation(Normalized.RightChop(10), *Args);
	}
	else if (Normalized.StartsWith(TEXT("widget.")))
	{
		Result = UEVGraph::HandleWidgetOperation(Normalized.RightChop(7), *Args);
	}
	else if (Normalized.StartsWith(TEXT("gameplay.")))
	{
		Result = HandleGameplayOperation(Normalized.RightChop(9), *Args);
	}
	else
	{
		Result = UEVGraph::MakeErrorObject(FString::Printf(TEXT("Unknown graph operation: %s"), *Operation));
	}
	return UEVGraph::Serialize(Result);
}
