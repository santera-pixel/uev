#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "UEVGraphAI.generated.h"

/**
 * Native helpers for AI assets that the UE 4.27 Python API cannot reach:
 * UBlackboardData::Keys and UBehaviorTree::RootNode are C++ only, and running a
 * behavior tree at edit time needs AAIController::RunBehaviorTree.
 *
 * Every entry point takes plain parameters and returns a single JSON object so the
 * Python layer only formats results. All functions use the public AIModule API and
 * never mutate an asset they did not create without saving it first.
 */
UCLASS()
class UEVGRAPHAUTHORING_API UUEVGraphAI : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	/** Describe a blackboard asset: parent chain, keys (name, type, instance sync, category) and key counts. */
	UFUNCTION(BlueprintCallable, Category = "UEV|AI")
	static FString DescribeBlackboard(const FString& BlackboardPath);

	/** Add a key to a blackboard asset and save it. KeyType is Bool, Int, Float, Vector, Rotator, Name, String, Object or Class. */
	UFUNCTION(BlueprintCallable, Category = "UEV|AI")
	static FString AddBlackboardKey(const FString& BlackboardPath, const FString& KeyName, const FString& KeyType, bool bInstanceSynced, const FString& Category, const FString& BaseClassPath);

	/** Remove a key from a blackboard asset and save it. Inherited parent keys cannot be removed here. */
	UFUNCTION(BlueprintCallable, Category = "UEV|AI")
	static FString RemoveBlackboardKey(const FString& BlackboardPath, const FString& KeyName);

	/** Describe a behavior tree: root node, recursive composites and tasks, decorators, services and blackboard keys. */
	UFUNCTION(BlueprintCallable, Category = "UEV|AI")
	static FString DescribeBehaviorTree(const FString& BehaviorTreePath);

	/** Assign and run a behavior tree on a placed or spawned AI controller, optionally possessing a pawn. */
	UFUNCTION(BlueprintCallable, Category = "UEV|AI")
	static FString AssignBehaviorTree(const FString& BehaviorTreePath, const FString& Target, const FString& PawnName, bool bSpawnIfMissing, bool bPossess);

	/**
	 * Single dispatch entry for behavior tree graph authoring (UEV 1.7).
	 *
	 * Operation is one of bt_create, bt_inspect, bt_add_node, bt_remove_node,
	 * bt_move_node, bt_set_node_property, bt_add_decorator, bt_remove_decorator,
	 * bt_add_service, bt_remove_service, bt_set_blackboard, bt_compile,
	 * bt_repair_graph. ArgsJson is a JSON object; the result is a JSON object.
	 *
	 * Implemented in UEVGraphBehaviorTree.cpp so the graph authoring code stays in
	 * its own translation unit while the Python layer keeps a single helper class.
	 */
	UFUNCTION(BlueprintCallable, Category = "UEV|AI")
	static FString ExecuteAIOperation(const FString& Operation, const FString& ArgsJson);
};
