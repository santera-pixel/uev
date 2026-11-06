#pragma once

#include "CoreMinimal.h"

/**
 * Behavior tree graph authoring for UEV 1.7.
 *
 * The engine's behavior tree editor classes are not exported (no
 * BEHAVIORTREEEDITOR_API), so this module never links BehaviorTreeEditor.
 * Instead it instantiates BehaviorTreeGraph, EdGraphSchema_BehaviorTree and the
 * UBehaviorTreeGraphNode_* classes by path and drives them through their
 * exported bases: UAIGraph::UpdateAsset(), UEdGraphSchema::CreateDefaultNodesForGraph(),
 * UAIGraphNode::AddSubNode() and so on. Virtual dispatch plus reflection keeps the
 * module independent of the editor module while producing exactly the same asset
 * state the editor produces on save.
 *
 * Durability rule: the runtime tree (UBehaviorTree::RootNode) and the editor graph
 * (UBehaviorTree::BTGraph) are authored in one transaction and one UpdateAsset()
 * pass. The editor's save/compile rebuilds the tree from the graph, so a graph that
 * is not mirrored would be destroyed by the next editor save.
 */
namespace UEVGraphBT
{
	/**
	 * Dispatch a behavior tree operation. Operation is the bt_* name (bt_create,
	 * bt_inspect, bt_add_node, ...); ArgsJson is a JSON object. Returns a JSON
	 * object string with success plus the operation payload.
	 */
	UEVGRAPHAUTHORING_API FString ExecuteBehaviorTreeOperation(const FString& Operation, const FString& ArgsJson);
}
