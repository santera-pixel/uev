#include "UEVGraphShared.h"

#include "AssetToolsModule.h"
#include "IAssetTools.h"
#include "MaterialEditingLibrary.h"
#include "Materials/MaterialExpression.h"
#include "Materials/MaterialExpressionConstant3Vector.h"
#include "Materials/MaterialExpressionConstant4Vector.h"
#include "Materials/MaterialExpressionFunctionOutput.h"
#include "Materials/MaterialExpressionVectorParameter.h"
#include "Materials/MaterialFunctionMaterialLayer.h"
#include "Materials/MaterialFunctionMaterialLayerBlend.h"
#include "Factories/MaterialFactoryNew.h"
#include "Factories/MaterialFunctionFactoryNew.h"
#include "Factories/MaterialFunctionMaterialLayerFactory.h"
#include "Factories/MaterialFunctionMaterialLayerBlendFactory.h"

namespace UEVGraph
{
	namespace
	{
		TArray<UMaterialExpression*> GetExpressions(UObject* Asset)
		{
			if (UMaterial* Material = Cast<UMaterial>(Asset))
			{
				return Material->Expressions;
			}
			if (UMaterialFunction* Function = Cast<UMaterialFunction>(Asset))
			{
				return Function->FunctionExpressions;
			}
			return {};
		}

		UObject* FindExpressionAsset(const FJsonObject& Args, bool& bOutIsFunction, FString& OutError)
		{
			FString Identifier = GetString(Args, TEXT("asset_path"));
			if (Identifier.IsEmpty()) Identifier = GetString(Args, TEXT("material_path"));
			if (Identifier.IsEmpty()) Identifier = GetString(Args, TEXT("function_path"));
			if (Identifier.IsEmpty()) Identifier = GetString(Args, TEXT("name"));
			UObject* Asset = LoadAsset(Identifier, UObject::StaticClass(), OutError);
			if (!Asset)
			{
				return nullptr;
			}
			bOutIsFunction = Asset->IsA(UMaterialFunction::StaticClass());
			if (!bOutIsFunction && !Asset->IsA(UMaterial::StaticClass()))
			{
				OutError = TEXT("Asset is not a Material or MaterialFunction.");
				return nullptr;
			}
			return Asset;
		}

		UMaterialExpression* FindExpression(UObject* Asset, const FString& Name)
		{
			TArray<FString> Candidates;
			Candidates.Add(Name);
			if (Name.StartsWith(TEXT("MaterialExpression"), ESearchCase::IgnoreCase))
			{
				Candidates.Add(Name.Mid(FCString::Strlen(TEXT("MaterialExpression"))));
			}
			else if (!Name.IsEmpty())
			{
				Candidates.Add(FString(TEXT("MaterialExpression")) + Name);
			}
			for (UMaterialExpression* Expression : GetExpressions(Asset))
			{
				if (!Expression)
				{
					continue;
				}
				for (const FString& Candidate : Candidates)
				{
					if (Expression->GetName().Equals(Candidate, ESearchCase::IgnoreCase)
						|| Expression->GetPathName().Equals(Candidate, ESearchCase::IgnoreCase))
					{
						return Expression;
					}
				}
			}
			return nullptr;
		}

		FString ExpressionNotFoundMessage(UObject* Asset, const FString& Name)
		{
			FString Available;
			for (UMaterialExpression* Expression : GetExpressions(Asset))
			{
				if (Expression)
				{
					if (!Available.IsEmpty())
					{
						Available += TEXT(", ");
					}
					Available += Expression->GetName();
				}
			}
			return FString::Printf(
				TEXT("Expression not found: %s. Available expressions: %s"),
				*Name,
				Available.IsEmpty() ? TEXT("(none)") : *Available);
		}

		FJsonObjectPtr SerializeExpression(UMaterialExpression* Expression)
		{
			FJsonObjectPtr Result = MakeObject();
			if (!Expression)
			{
				return Result;
			}
			Result->SetStringField(TEXT("name"), Expression->GetName());
			Result->SetStringField(TEXT("class"), Expression->GetClass()->GetName());
			Result->SetNumberField(TEXT("x"), Expression->MaterialExpressionEditorX);
			Result->SetNumberField(TEXT("y"), Expression->MaterialExpressionEditorY);

			TArray<TSharedPtr<FJsonValue>> Inputs;
			const TArray<FExpressionInput*> ExpressionInputs = Expression->GetInputs();
			for (int32 Index = 0; Index < ExpressionInputs.Num(); ++Index)
			{
				FExpressionInput* Input = ExpressionInputs[Index];
				if (!Input)
				{
					continue;
				}
				FJsonObjectPtr InputObject = MakeObject();
				InputObject->SetStringField(TEXT("name"), Expression->GetInputName(Index).ToString());
				InputObject->SetStringField(TEXT("source"), Input->Expression ? Input->Expression->GetName() : FString());
				InputObject->SetNumberField(TEXT("output_index"), Input->OutputIndex);
				Inputs.Add(MakeShared<FJsonValueObject>(InputObject));
			}
			Result->SetArrayField(TEXT("inputs"), Inputs);

			TArray<TSharedPtr<FJsonValue>> Outputs;
			const TArray<FExpressionOutput>& ExpressionOutputs = Expression->GetOutputs();
			for (int32 OutputIndex = 0; OutputIndex < ExpressionOutputs.Num(); ++OutputIndex)
			{
				const FExpressionOutput& Output = ExpressionOutputs[OutputIndex];
				FString OutputName = Output.OutputName.ToString();
				if (OutputName.IsEmpty() || Output.OutputName.IsNone())
				{
					// Many expressions leave OutputName unset even though the
					// material editor shows a usable label.
					OutputName = OutputIndex == 0 ? TEXT("Output") : FString::Printf(TEXT("Output%d"), OutputIndex);
				}
				FJsonObjectPtr OutputObject = MakeObject();
				OutputObject->SetStringField(TEXT("name"), OutputName);
				OutputObject->SetNumberField(TEXT("index"), OutputIndex);
				Outputs.Add(MakeShared<FJsonValueObject>(OutputObject));
			}
			Result->SetArrayField(TEXT("outputs"), Outputs);

			// Surface the common literal/parameter values so callers can verify
			// edits without opening the material editor. Values are exported
			// through reflection, so this stays generic across expression types.
			FJsonObjectPtr Properties = MakeObject();
			auto ExportProperty = [Expression, &Properties](const TCHAR* PropertyName, const TCHAR* Label)
			{
				if (FProperty* Property = Expression->GetClass()->FindPropertyByName(FName(PropertyName)))
				{
					FString Value;
					Property->ExportText_Direct(
						Value,
						Property->ContainerPtrToValuePtr<void>(Expression),
						nullptr,
						Expression,
						PPF_None);
					Properties->SetStringField(Label, Value);
				}
			};
			ExportProperty(TEXT("Constant"), TEXT("constant"));
			ExportProperty(TEXT("DefaultValue"), TEXT("default_value"));
			ExportProperty(TEXT("ParameterName"), TEXT("parameter_name"));
			ExportProperty(TEXT("Texture"), TEXT("texture"));
			ExportProperty(TEXT("R"), TEXT("r"));
			ExportProperty(TEXT("G"), TEXT("g"));
			ExportProperty(TEXT("B"), TEXT("b"));
			ExportProperty(TEXT("A"), TEXT("a"));
			if (Properties->Values.Num() > 0)
			{
				Result->SetObjectField(TEXT("properties"), Properties);
			}
			return Result;
		}

		FString MaterialPropertyName(EMaterialProperty Property)
		{
			switch (Property)
			{
			case MP_BaseColor: return TEXT("base_color");
			case MP_Metallic: return TEXT("metallic");
			case MP_Specular: return TEXT("specular");
			case MP_Roughness: return TEXT("roughness");
			case MP_EmissiveColor: return TEXT("emissive_color");
			case MP_Opacity: return TEXT("opacity");
			case MP_OpacityMask: return TEXT("opacity_mask");
			case MP_Normal: return TEXT("normal");
			case MP_WorldPositionOffset: return TEXT("world_position_offset");
			case MP_AmbientOcclusion: return TEXT("ambient_occlusion");
			case MP_Refraction: return TEXT("refraction");
			case MP_PixelDepthOffset: return TEXT("pixel_depth_offset");
			case MP_ShadingModel: return TEXT("shading_model");
			case MP_Anisotropy: return TEXT("anisotropy");
			case MP_Tangent: return TEXT("tangent");
			default: return FString();
			}
		}

		bool ParseMaterialProperty(const FString& Name, EMaterialProperty& OutProperty)
		{
			FString Normalized = Name.ToLower().Replace(TEXT("-"), TEXT("_")).Replace(TEXT(" "), TEXT("_"));
			if (Normalized == TEXT("base_color") || Normalized == TEXT("basecolor")) OutProperty = MP_BaseColor;
			else if (Normalized == TEXT("metallic")) OutProperty = MP_Metallic;
			else if (Normalized == TEXT("specular")) OutProperty = MP_Specular;
			else if (Normalized == TEXT("roughness")) OutProperty = MP_Roughness;
			else if (Normalized == TEXT("emissive_color") || Normalized == TEXT("emissive")) OutProperty = MP_EmissiveColor;
			else if (Normalized == TEXT("opacity")) OutProperty = MP_Opacity;
			else if (Normalized == TEXT("opacity_mask") || Normalized == TEXT("opacitymask")) OutProperty = MP_OpacityMask;
			else if (Normalized == TEXT("normal")) OutProperty = MP_Normal;
			else if (Normalized == TEXT("world_position_offset") || Normalized == TEXT("worldpositionoffset")) OutProperty = MP_WorldPositionOffset;
			else if (Normalized == TEXT("ambient_occlusion") || Normalized == TEXT("ambientocclusion")) OutProperty = MP_AmbientOcclusion;
			else if (Normalized == TEXT("refraction")) OutProperty = MP_Refraction;
			else if (Normalized == TEXT("pixel_depth_offset") || Normalized == TEXT("pixeldepthoffset")) OutProperty = MP_PixelDepthOffset;
			else if (Normalized == TEXT("shading_model") || Normalized == TEXT("shadingmodel")) OutProperty = MP_ShadingModel;
			else if (Normalized == TEXT("anisotropy")) OutProperty = MP_Anisotropy;
			else if (Normalized == TEXT("tangent")) OutProperty = MP_Tangent;
			else return false;
			return true;
		}

		FString DefaultPackagePath(const FJsonObject& Args)
		{
			FString Path = GetString(Args, TEXT("path"), TEXT("/Game/UEV/Generated"));
			if (!Path.StartsWith(TEXT("/")))
			{
				Path = TEXT("/Game/") + Path;
			}
			return Path;
		}

		FString AssetName(const FJsonObject& Args, const FString& Field)
		{
			FString Name = GetString(Args, Field);
			if (Name.IsEmpty()) Name = GetString(Args, TEXT("name"));
			return Name;
		}

		UObject* CreateAsset(UClass* AssetClass, const FString& Name, const FString& Path, UFactory* Factory, FString& OutError)
		{
			if (Name.IsEmpty())
			{
				OutError = TEXT("Asset name is required.");
				return nullptr;
			}
			IAssetTools& AssetTools = FModuleManager::LoadModuleChecked<FAssetToolsModule>("AssetTools").Get();
			UObject* Asset = AssetTools.CreateAsset(Name, Path, AssetClass, Factory);
			if (!Asset)
			{
				OutError = FString::Printf(TEXT("Could not create asset %s/%s."), *Path, *Name);
			}
			return Asset;
		}
	}

	FJsonObjectPtr HandleMaterialOperationInternal(const FString& Operation, const FJsonObject& Args)
	{
		FString Error;
		if (Operation == TEXT("inspect_graph"))
		{
			bool bIsFunction = false;
			UObject* Asset = FindExpressionAsset(Args, bIsFunction, Error);
			if (!Asset)
			{
				return MakeErrorObject(Error);
			}
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetStringField(TEXT("asset_path"), Asset->GetPathName());
			Result->SetStringField(TEXT("class"), Asset->GetClass()->GetName());
			TArray<TSharedPtr<FJsonValue>> Expressions;
			for (UMaterialExpression* Expression : GetExpressions(Asset))
			{
				Expressions.Add(MakeShared<FJsonValueObject>(SerializeExpression(Expression)));
			}
			Result->SetArrayField(TEXT("expressions"), Expressions);

			if (UMaterial* Material = Cast<UMaterial>(Asset))
			{
				TArray<TSharedPtr<FJsonValue>> Properties;
				const EMaterialProperty PropertiesToInspect[] = {
					MP_BaseColor, MP_Metallic, MP_Specular, MP_Roughness, MP_EmissiveColor,
					MP_Opacity, MP_OpacityMask, MP_Normal, MP_WorldPositionOffset,
					MP_AmbientOcclusion, MP_Refraction, MP_PixelDepthOffset, MP_Anisotropy,
					MP_Tangent, MP_ShadingModel
				};
				for (EMaterialProperty Property : PropertiesToInspect)
				{
					UMaterialExpression* Input = UMaterialEditingLibrary::GetMaterialPropertyInputNode(Material, Property);
					if (!Input)
					{
						continue;
					}
					FJsonObjectPtr PropertyObject = MakeObject();
					PropertyObject->SetStringField(TEXT("property"), MaterialPropertyName(Property));
					PropertyObject->SetStringField(TEXT("expression"), Input->GetName());
					Properties.Add(MakeShared<FJsonValueObject>(PropertyObject));
				}
				Result->SetArrayField(TEXT("property_inputs"), Properties);
			}
			else if (UMaterialFunction* Function = Cast<UMaterialFunction>(Asset))
			{
				TArray<TSharedPtr<FJsonValue>> Outputs;
				for (UMaterialExpression* Expression : Function->FunctionExpressions)
				{
					if (UMaterialExpressionFunctionOutput* Output = Cast<UMaterialExpressionFunctionOutput>(Expression))
					{
						FJsonObjectPtr OutputObject = MakeObject();
						OutputObject->SetStringField(TEXT("name"), Output->OutputName.ToString());
						Outputs.Add(MakeShared<FJsonValueObject>(OutputObject));
					}
				}
				Result->SetArrayField(TEXT("function_outputs"), Outputs);
			}
			return Result;
		}

		if (Operation == TEXT("create_material"))
		{
			UObject* Asset = CreateAsset(
				UMaterial::StaticClass(),
				AssetName(Args, TEXT("asset_name")),
				DefaultPackagePath(Args),
				NewObject<UMaterialFactoryNew>(),
				Error);
			if (!Asset)
			{
				return MakeErrorObject(Error);
			}
			Asset->GetOutermost()->MarkPackageDirty();
			SaveAsset(Asset, Error);
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetStringField(TEXT("asset_path"), Asset->GetPathName());
			return Result;
		}

		if (Operation == TEXT("create_material_function"))
		{
			const FString FunctionType = GetString(Args, TEXT("function_type"), TEXT("function")).ToLower();
			UClass* AssetClass = UMaterialFunction::StaticClass();
			UFactory* Factory = nullptr;
			if (FunctionType == TEXT("layer"))
			{
				AssetClass = UMaterialFunctionMaterialLayer::StaticClass();
				Factory = NewObject<UMaterialFunctionMaterialLayerFactory>();
			}
			else if (FunctionType == TEXT("layer_blend") || FunctionType == TEXT("layerblend"))
			{
				AssetClass = UMaterialFunctionMaterialLayerBlend::StaticClass();
				Factory = NewObject<UMaterialFunctionMaterialLayerBlendFactory>();
			}
			else
			{
				Factory = NewObject<UMaterialFunctionFactoryNew>();
			}
			UObject* Asset = CreateAsset(
				AssetClass,
				AssetName(Args, TEXT("asset_name")),
				DefaultPackagePath(Args),
				Factory,
				Error);
			if (!Asset)
			{
				return MakeErrorObject(Error);
			}
			Asset->GetOutermost()->MarkPackageDirty();
			SaveAsset(Asset, Error);
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetStringField(TEXT("asset_path"), Asset->GetPathName());
			return Result;
		}

		if (Operation == TEXT("add_expression") || Operation == TEXT("add_function_output"))
		{
			bool bIsFunction = false;
			UObject* Asset = FindExpressionAsset(Args, bIsFunction, Error);
			if (!Asset)
			{
				return MakeErrorObject(Error);
			}
			Asset->Modify();
			FString ClassName = Operation == TEXT("add_function_output")
				? TEXT("MaterialExpressionFunctionOutput")
				: GetString(Args, TEXT("expression_class"), GetString(Args, TEXT("class")));
			// Accept the short names used in the material editor UI
			// ("Constant3Vector", "VectorParameter") in addition to the full
			// class name or a /Script path.
			if (!ClassName.StartsWith(TEXT("/")) && !ClassName.Contains(TEXT(".")) && !ClassName.StartsWith(TEXT("MaterialExpression")))
			{
				ClassName = TEXT("MaterialExpression") + ClassName;
			}
			UClass* ExpressionClass = ResolveClass(ClassName, UMaterialExpression::StaticClass(), Error);
			if (!ExpressionClass)
			{
				return MakeErrorObject(Error);
			}
			const int32 X = static_cast<int32>(GetNumber(Args, TEXT("x"), 0.0));
			const int32 Y = static_cast<int32>(GetNumber(Args, TEXT("y"), 0.0));
			UMaterialExpression* Expression = nullptr;
			if (UMaterial* Material = Cast<UMaterial>(Asset))
			{
				Expression = UMaterialEditingLibrary::CreateMaterialExpression(Material, ExpressionClass, X, Y);
			}
			else if (UMaterialFunction* Function = Cast<UMaterialFunction>(Asset))
			{
				Expression = UMaterialEditingLibrary::CreateMaterialExpressionInFunction(Function, ExpressionClass, X, Y);
			}
			if (!Expression)
			{
				return MakeErrorObject(TEXT("Could not create material expression."));
			}
			if (Operation == TEXT("add_function_output"))
			{
				if (UMaterialExpressionFunctionOutput* Output = Cast<UMaterialExpressionFunctionOutput>(Expression))
				{
					Output->OutputName = FName(*GetString(Args, TEXT("output_name"), TEXT("Result")));
					Output->SortPriority = static_cast<int32>(GetNumber(Args, TEXT("sort_priority"), 0.0));
				}
			}
			const TSharedPtr<FJsonObject> Properties = GetObject(Args, TEXT("properties"));
			if (Properties.IsValid())
			{
				// Accept the colour shorthand used in the material editor:
				// {"r":1,"g":0,"b":0,"a":1} maps onto the expression's colour
				// struct property instead of requiring an explicit Constant /
				// DefaultValue object.
				FString ColourProperty;
				if (Expression->IsA(UMaterialExpressionVectorParameter::StaticClass()))
				{
					ColourProperty = TEXT("DefaultValue");
				}
				else if (Expression->IsA(UMaterialExpressionConstant3Vector::StaticClass())
					|| Expression->IsA(UMaterialExpressionConstant4Vector::StaticClass()))
				{
					ColourProperty = TEXT("Constant");
				}
				TSharedPtr<FJsonObject> Effective = MakeShared<FJsonObject>();
				TSharedPtr<FJsonObject> ColourObject = MakeShared<FJsonObject>();
				bool bHasColourChannels = false;
				for (const auto& Pair : Properties->Values)
				{
					const FString Key = Pair.Key.ToLower();
					if (!ColourProperty.IsEmpty() && (Key == TEXT("r") || Key == TEXT("g") || Key == TEXT("b") || Key == TEXT("a")))
					{
						ColourObject->SetField(Key.ToUpper(), Pair.Value);
						bHasColourChannels = true;
						continue;
					}
					Effective->SetField(Pair.Key, Pair.Value);
				}
				if (bHasColourChannels && !Effective->HasField(ColourProperty))
				{
					Effective->SetObjectField(ColourProperty, ColourObject);
				}
				for (const auto& Pair : Effective->Values)
				{
					if (!SetObjectPropertyPath(Expression, Pair.Key, Pair.Value, Error))
					{
						return MakeErrorObject(Error);
					}
				}
			}
			Asset->GetOutermost()->MarkPackageDirty();
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetObjectField(TEXT("expression"), SerializeExpression(Expression));
			return Result;
		}

		if (Operation == TEXT("connect"))
		{
			bool bIsFunction = false;
			UObject* Asset = FindExpressionAsset(Args, bIsFunction, Error);
			if (!Asset)
			{
				return MakeErrorObject(Error);
			}
			const FString SourceName = GetString(Args, TEXT("source_expression"));
			const FString TargetName = GetString(Args, TEXT("target_expression"));
			UMaterialExpression* Source = FindExpression(Asset, SourceName);
			UMaterialExpression* Target = FindExpression(Asset, TargetName);
			Asset->Modify();
			if (!Source)
			{
				return MakeErrorObject(ExpressionNotFoundMessage(Asset, SourceName));
			}
			if (!Target)
			{
				return MakeErrorObject(ExpressionNotFoundMessage(Asset, TargetName));
			}
			const bool bConnected = UMaterialEditingLibrary::ConnectMaterialExpressions(
				Source,
				GetString(Args, TEXT("source_output")),
				Target,
				GetString(Args, TEXT("target_input")));
			if (!bConnected)
			{
				return MakeErrorObject(TEXT("Material expression connection was rejected."));
			}
			Asset->GetOutermost()->MarkPackageDirty();
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetObjectField(TEXT("source"), SerializeExpression(Source));
			Result->SetObjectField(TEXT("target"), SerializeExpression(Target));
			return Result;
		}

		if (Operation == TEXT("connect_property"))
		{
			UMaterial* Material = LoadMaterial(Args, Error);
			if (!Material)
			{
				return MakeErrorObject(Error);
			}
			const FString SourceName = GetString(Args, TEXT("expression"));
			UMaterialExpression* Source = FindExpression(Material, SourceName);
			Material->Modify();
			if (!Source)
			{
				return MakeErrorObject(ExpressionNotFoundMessage(Material, SourceName));
			}
			EMaterialProperty Property = MP_BaseColor;
			if (!ParseMaterialProperty(GetString(Args, TEXT("property")), Property))
			{
				return MakeErrorObject(FString::Printf(
					TEXT("Unknown material property: %s. Use base_color, metallic, specular, roughness, emissive_color, opacity, normal, ambient_occlusion, or world_position_offset."),
					*GetString(Args, TEXT("property"))));
			}
			if (!UMaterialEditingLibrary::ConnectMaterialProperty(Source, GetString(Args, TEXT("source_output")), Property))
			{
				return MakeErrorObject(TEXT("Material property connection was rejected."));
			}
			Material->GetOutermost()->MarkPackageDirty();
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetStringField(TEXT("expression"), Source->GetName());
			Result->SetStringField(TEXT("property"), MaterialPropertyName(Property));
			return Result;
		}

		if (Operation == TEXT("delete_expression"))
		{
			bool bIsFunction = false;
			UObject* Asset = FindExpressionAsset(Args, bIsFunction, Error);
			if (!Asset)
			{
				return MakeErrorObject(Error);
			}
			UMaterialExpression* Expression = FindExpression(Asset, GetString(Args, TEXT("expression")));
			if (!Expression)
			{
				return MakeErrorObject(ExpressionNotFoundMessage(Asset, GetString(Args, TEXT("expression"))));
			}
			Asset->Modify();
			if (UMaterial* Material = Cast<UMaterial>(Asset))
			{
				UMaterialEditingLibrary::DeleteMaterialExpression(Material, Expression);
			}
			else if (UMaterialFunction* Function = Cast<UMaterialFunction>(Asset))
			{
				UMaterialEditingLibrary::DeleteMaterialExpressionInFunction(Function, Expression);
			}
			Asset->GetOutermost()->MarkPackageDirty();
			return MakeSuccess();
		}

		if (Operation == TEXT("set_expression_property"))
		{
			bool bIsFunction = false;
			UObject* Asset = FindExpressionAsset(Args, bIsFunction, Error);
			if (!Asset)
			{
				return MakeErrorObject(Error);
			}
			UMaterialExpression* Expression = FindExpression(Asset, GetString(Args, TEXT("expression")));
			if (!Expression)
			{
				return MakeErrorObject(ExpressionNotFoundMessage(Asset, GetString(Args, TEXT("expression"))));
			}
			Asset->Modify();
			Expression->Modify();
			const TSharedPtr<FJsonValue> Value = Args.TryGetField(TEXT("value"));
			if (!Value.IsValid() || !SetObjectPropertyPath(Expression, GetString(Args, TEXT("property")), Value, Error))
			{
				return MakeErrorObject(Error.IsEmpty() ? TEXT("property and value are required.") : Error);
			}
			Expression->PostEditChange();
			Asset->GetOutermost()->MarkPackageDirty();
			FJsonObjectPtr Result = MakeSuccess();
			Result->SetObjectField(TEXT("expression"), SerializeExpression(Expression));
			return Result;
		}

		if (Operation == TEXT("layout"))
		{
			bool bIsFunction = false;
			UObject* Asset = FindExpressionAsset(Args, bIsFunction, Error);
			if (!Asset)
			{
				return MakeErrorObject(Error);
			}
			Asset->Modify();
			if (UMaterial* Material = Cast<UMaterial>(Asset))
			{
				UMaterialEditingLibrary::LayoutMaterialExpressions(Material);
			}
			else if (UMaterialFunction* Function = Cast<UMaterialFunction>(Asset))
			{
				UMaterialEditingLibrary::LayoutMaterialFunctionExpressions(Function);
			}
			Asset->GetOutermost()->MarkPackageDirty();
			return MakeSuccess();
		}

		if (Operation == TEXT("recompile"))
		{
			UMaterial* Material = LoadMaterial(Args, Error);
			if (!Material)
			{
				return MakeErrorObject(Error);
			}
			UMaterialEditingLibrary::RecompileMaterial(Material);
			Material->GetOutermost()->MarkPackageDirty();
			return MakeSuccess();
		}

		if (Operation == TEXT("save"))
		{
			bool bIsFunction = false;
			UObject* Asset = FindExpressionAsset(Args, bIsFunction, Error);
			if (!Asset)
			{
				return MakeErrorObject(Error);
			}
			if (!SaveAsset(Asset, Error))
			{
				return MakeErrorObject(Error);
			}
			return MakeSuccess();
		}

		return MakeErrorObject(FString::Printf(TEXT("Unknown material graph operation: %s"), *Operation));
	}

	FJsonObjectPtr HandleMaterialOperation(const FString& Operation, const FJsonObject& Args)
	{
		FJsonObjectPtr Result = HandleMaterialOperationInternal(Operation, Args);
		bool bSuccess = false;
		if (!Result.IsValid() || !Result->TryGetBoolField(TEXT("success"), bSuccess) || !bSuccess)
		{
			return Result;
		}
		static const TSet<FString> Mutations = {
			TEXT("create_material"), TEXT("create_material_function"), TEXT("add_expression"),
			TEXT("add_function_output"), TEXT("connect"), TEXT("connect_property"), TEXT("delete_expression"),
			TEXT("set_expression_property"), TEXT("layout"), TEXT("recompile")
		};
		if (!Mutations.Contains(Operation))
		{
			return Result;
		}
		FString Error;
		bool bIsFunction = false;
		UObject* Asset = FindExpressionAsset(Args, bIsFunction, Error);
		return Asset ? FinalizeAssetEdit(Asset, Args, Result) : Result;
	}
}
