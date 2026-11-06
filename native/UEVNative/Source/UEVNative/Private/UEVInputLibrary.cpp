#include "UEVInputLibrary.h"

#include "Editor.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"
#include "InputCoreTypes.h"

bool UUEVInputLibrary::StartPIEPlay()
{
	if (!GEditor)
	{
		return false;
	}

	if (GEditor->PlayWorld)
	{
		return true;
	}

	FRequestPlaySessionParams Params;
	Params.WorldType = EPlaySessionWorldType::PlayInEditor;
	GEditor->RequestPlaySession(Params);
	return true;
}

APlayerController* UUEVInputLibrary::GetPIEPlayerController()
{
	if (!GEditor || !GEditor->PlayWorld)
	{
		return nullptr;
	}

	for (FConstPlayerControllerIterator It = GEditor->PlayWorld->GetPlayerControllerIterator(); It; ++It)
	{
		if (APlayerController* PlayerController = It->Get())
		{
			return PlayerController;
		}
	}

	return nullptr;
}

bool UUEVInputLibrary::InjectKey(const FString& KeyName, bool bPressed)
{
	APlayerController* PlayerController = GetPIEPlayerController();
	if (!PlayerController || KeyName.IsEmpty())
	{
		return false;
	}

	const FKey Key{FName(*KeyName)};
	if (!Key.IsValid())
	{
		return false;
	}

	return PlayerController->InputKey(Key, bPressed ? IE_Pressed : IE_Released, 1.0f, false);
}

bool UUEVInputLibrary::InjectMouseButton(const FString& ButtonName, bool bPressed)
{
	APlayerController* PlayerController = GetPIEPlayerController();
	if (!PlayerController || ButtonName.IsEmpty())
	{
		return false;
	}

	const FString Normalized = ButtonName.ToLower();
	FKey Button;
	if (Normalized == TEXT("left"))
	{
		Button = EKeys::LeftMouseButton;
	}
	else if (Normalized == TEXT("right"))
	{
		Button = EKeys::RightMouseButton;
	}
	else if (Normalized == TEXT("middle"))
	{
		Button = EKeys::MiddleMouseButton;
	}
	else
	{
		Button = FKey{FName(*ButtonName)};
	}

	if (!Button.IsValid() || !Button.IsMouseButton())
	{
		return false;
	}

	PlayerController->InputKey(Button, bPressed ? IE_Pressed : IE_Released, 1.0f, false);
	return true;
}

bool UUEVInputLibrary::InjectMouseMove(float DeltaX, float DeltaY)
{
	APlayerController* PlayerController = GetPIEPlayerController();
	if (!PlayerController || !FMath::IsFinite(DeltaX) || !FMath::IsFinite(DeltaY))
	{
		return false;
	}

	if (FMath::IsNearlyZero(DeltaX) && FMath::IsNearlyZero(DeltaY))
	{
		return false;
	}

	constexpr float DeltaTime = 1.0f / 60.0f;
	PlayerController->InputAxis(EKeys::MouseX, DeltaX, DeltaTime, 1, false);
	PlayerController->InputAxis(EKeys::MouseY, DeltaY, DeltaTime, 1, false);
	return true;
}
