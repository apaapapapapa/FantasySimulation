import type { DeepReadonly, Definition } from '@fantasy/domain/spatial/execution';
import { metres } from './terrain.ts';

type NavigationTopology = DeepReadonly<Definition<'scenario'>['navigation']>;
type Adjacent = { edge: NavigationTopology['edges'][number]; next: string };

/** Static topology only; clearance, resource costs and query work remain in Navigator.find. */
export function prepareNavigationGraph(navigation: NavigationTopology, flight: boolean) {
  const nodes = navigation.nodes.filter((node) => node.mode === (flight ? 'air' : 'ground'));
  const points = new Map(nodes.map((node) => [node.id, metres(node.position)]));
  const adjacent = new Map<string, Adjacent[]>();
  function add(from: string, next: string, edge: Adjacent['edge']) {
    if (!points.has(from)) return;
    let list = adjacent.get(from);
    if (!list) {
      list = [];
      adjacent.set(from, list);
    }
    list.push({ edge, next });
  }
  // Preserve authored edge order, parallel edges and the original self-edge precedence.
  for (const edge of navigation.edges) {
    add(edge.from, edge.to, edge);
    if (edge.bidirectional && edge.to !== edge.from) add(edge.to, edge.from, edge);
  }
  return { nodes, points, adjacent };
}
