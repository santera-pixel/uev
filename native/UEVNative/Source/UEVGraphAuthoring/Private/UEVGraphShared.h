#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "EdGraph/EdGraphPin.h"
#include "Engine/Blueprint.h"
#include "Materials/Material.h"
#include "Materials/MaterialFunction.h"
#include "Animation/AnimBlueprint.h"
#include "Animation/AnimSequence.h"
#include "Animation/AnimMontage.h"

class USCS_Node;

namespace UEVGraph
{
	using FJsonObjectPtr = TSharedPtr<FJsonObject>;
	using FJsonValuePtr = TSharedPtr<FJsonValue>;

	FJsonObjectPtr MakeObject();
	FJsonObjectPtr MakeErrorObject(const FString& Message);
	FJsonObjectPtr MakeSuccess();

	/** True while any Play In Editor (or standalone game) world is alive in this editor session. */
	bool IsPlayInEditorActive(int32& OutWorldCount);

	/** True when the operator opted into unsafe operations (UEV_ALLOW_UNSAFE_OPERATIONS). */
	bool UnsafeOperationsAllowed();

	/**
	 * Structured refusal that mirrors the Python crash guards: success=false plus
	 * error.code=unsafe_operation_refused, error.guard, error.hint and a guard block.
	 */
	FJsonObjectPtr MakeGuardRefusal(
		const FString& GuardId,
		const FString& GuardTitle,
		const FString& Message,
		const FString& Hint);
	FString Serialize(const FJsonObjectPtr& Object);

	FString GetString(const FJsonObject& Object, const FString& Field, const FString& Default = FString());
	bool GetBool(const FJsonObject& Object, const FString& Field, bool bDefault = false);
	double GetNumber(const FJsonObject& Object, const FString& Field, double Default = 0.0);
	FJsonObjectPtr GetObject(const FJsonObject& Object, const FString& Field);
	const TArray<TSharedPtr<FJsonValue>>* GetArray(const FJsonObject& Object, const FString& Field);

	FString AssetIdentifier(const FJsonObject& Args);
	UObject* LoadAsset(const FString& Identifier, UClass* ExpectedClass, FString& OutError);
	UClass* ResolveClass(const FString& ClassName, UClass* ExpectedBase, FString& OutError);
	UBlueprint* LoadBlueprint(const FJsonObject& Args, FString& OutError);
	UAnimBlueprint* LoadAnimBlueprint(const FJsonObject& Args, FString& OutError);
	UMaterial* LoadMaterial(const FJsonObject& Args, FString& OutError);
	UMaterialFunction* LoadMaterialFunction(const FJsonObject& Args, FString& OutError);
	UAnimSequence* LoadAnimSequence(const FJsonObject& Args, FString& OutError);
	UAnimMontage* LoadAnimMontage(const FJsonObject& Args, FString& OutError);

	UEdGraph* ResolveGraph(UBlueprint* Blueprint, const FString& GraphName, FString& OutError);
	UEdGraph* FindGraphByName(UBlueprint* Blueprint, const FString& GraphName);
	UEdGraphNode* FindNode(UBlueprint* Blueprint, const FString& NodeId, UEdGraph** OutGraph = nullptr);
	UEdGraphNode* FindNodeInGraph(UEdGraph* Graph, const FString& NodeId);
	/** Resolve the optional graph_name argument: nullptr with bOutNamed=false when absent, nullptr with OutError set when named but missing. */
	UEdGraph* ResolveOptionalGraph(UBlueprint* Blueprint, const FJsonObject& Args, bool& bOutNamed, FString& OutError);
	UEdGraphPin* FindPin(UEdGraphNode* Node, const FString& PinName);
	FString NodeId(UEdGraphNode* Node);
	FString PinName(UEdGraphPin* Pin);
	FString PinTypeName(const FEdGraphPinType& Type);

	FJsonObjectPtr SerializeNode(UEdGraphNode* Node, UEdGraph* Graph);
	FJsonObjectPtr SerializeGraph(UEdGraph* Graph, bool bIncludeNodes);
	void AppendGraphs(UBlueprint* Blueprint, TArray<UEdGraph*>& OutGraphs, bool bIncludeSubGraphs);

	/** Stable graph identifier (UEdGraph::GraphGuid), or a name-derived fallback for graphs without a GUID. */
	FString GraphId(UEdGraph* Graph);
	/** UBlueprint that owns the graph (walks outers/subgraphs); nullptr for non-blueprint graphs. */
	UBlueprint* FindOwningBlueprint(UEdGraph* Graph);
	UEdGraph* FindParentGraph(UEdGraph* Graph);
	/** ubergraph | function | macro | delegate | subgraph | anim | unknown */
	FString GraphKind(UEdGraph* Graph);
	UEdGraph* FindGraphById(UBlueprint* Blueprint, const FString& InGraphId);
	/** Resolve graph_id first, then graph_name/alias; nullptr + OutError when the request cannot be satisfied. */
	UEdGraph* ResolveGraphArg(UBlueprint* Blueprint, const FJsonObject& Args, bool& bOutNamed, FString& OutError);
	void AppendGraphSummaries(UBlueprint* Blueprint, bool bIncludeSubGraphs, TArray<TSharedPtr<FJsonValue>>& OutGraphs);
	/** Structured graph_not_found error listing the candidate graph ids and names. */
	FJsonObjectPtr MakeGraphNotFoundError(const FString& Requested, UBlueprint* Blueprint);
	/** Structured { code, message } error envelope. */
	FJsonObjectPtr MakeCodedError(const FString& Code, const FString& Message);
	/** Refreshed graphs:[{graph_id,name,kind}] envelope for mutations. */
	FJsonObjectPtr MakeGraphEnvelope(UBlueprint* Blueprint);
	/** pie-editor-mutation refusal for graph operations that trigger a synchronous compile. */
	bool GuardGraphMutation(const FString& ActionLabel, FJsonObjectPtr& OutRefusal);

	bool IsConstructionScriptGraph(UBlueprint* Blueprint, UEdGraph* Graph);
	bool PinTypeFromArgs(const FJsonObject& Args, const FString& Field, const FString& DefaultType, FEdGraphPinType& OutType, FString& OutError);
	FString SerializePinTypeField(const FEdGraphPinType& Type);

	bool ConnectPins(UEdGraphPin* SourcePin, UEdGraphPin* TargetPin, FString& OutError);
	int32 DisconnectPins(UEdGraphPin* SourcePin, UEdGraphPin* TargetPin, FString& OutError);
	bool SetPinDefault(UEdGraphPin* Pin, const FJsonValuePtr& Value, FString& OutError);
	bool SetObjectPropertyPath(UObject* Object, const FString& PropertyPath, const FJsonValuePtr& Value, FString& OutError);
	bool SaveAsset(UObject* Asset, FString& OutError);
	FJsonObjectPtr FinalizeAssetEdit(UObject* Asset, const FJsonObject& Args, FJsonObjectPtr Result);
	bool CompileBlueprint(UBlueprint* Blueprint, FJsonObjectPtr& OutResult);

	UClass* ResolveFunctionOwner(UBlueprint* Blueprint, const FString& Target, FString& OutError);
	UFunction* FindFunction(UClass* OwnerClass, const FString& FunctionName);
	USCS_Node* FindComponentNode(UBlueprint* Blueprint, const FString& ComponentName);
	FString ComponentClassPath(UBlueprint* Blueprint, const FString& ComponentName);

	FJsonObjectPtr HandleBlueprintOperation(const FString& Operation, const FJsonObject& Args);
	/** Blueprint depth operations (functions, macros, construction scripts). Returns nullptr when the operation is unknown. */
	FJsonObjectPtr HandleBlueprintDepthOperation(const FString& Operation, const FJsonObject& Args);
	FJsonObjectPtr HandleMaterialOperation(const FString& Operation, const FJsonObject& Args);
	FJsonObjectPtr HandleAnimationOperation(const FString& Operation, const FJsonObject& Args);
	FJsonObjectPtr HandleAnimationGraphOperation(const FString& Operation, const FJsonObject& Args);
	FJsonObjectPtr HandleWidgetOperation(const FString& Operation, const FJsonObject& Args);
}
