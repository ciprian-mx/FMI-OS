import fc from 'fast-check';
import {
  FolderNode,
  PATH_SEPARATOR,
  buildPath,
  getAncestors,
  getChildren,
  getDescendants,
  getSubtree,
  indexById,
  isAncestor,
  normalizeFolderName,
  planDelete,
  planMove,
  planRename,
  validateCreate,
  validateFolderName,
  validateMove,
} from './folderHierarchy';

/**
 * Task 4.1 — Materials folder-hierarchy data-layer helpers.
 *
 * Covers the pure operations the Materials tree view (task 4.2) and upload flow
 * (task 4.5) rely on: materialized-path construction, parent-reference
 * validation, cycle prevention, children/subtree listing, and the recursive
 * path-rewrite / delete planning for move / rename / delete. Unit tests pin
 * concrete examples and edge cases; property-based tests assert the invariants
 * that must hold for every hierarchy.
 *
 * Validates: Requirements 7.1, 7.2
 */

const STUDENT = 'student-1';

function node(
  id: string,
  parentId: string | null,
  name: string,
  path: string,
  studentId: string = STUDENT
): FolderNode {
  return { id, studentId, name, parentId, path, createdDate: '2024-01-01T00:00:00Z' };
}

/** A small fixed tree:
 *   root (Materials)
 *     ├── ds  (Data Structures)
 *     │     ├── w1 (Week 1)
 *     │     └── w3 (Week 3)
 *     └── algo (Algorithms)
 */
function sampleTree(): FolderNode[] {
  return [
    node('root', null, 'Materials', 'Materials'),
    node('ds', 'root', 'Data Structures', 'Materials/Data Structures'),
    node('w1', 'ds', 'Week 1', 'Materials/Data Structures/Week 1'),
    node('w3', 'ds', 'Week 3', 'Materials/Data Structures/Week 3'),
    node('algo', 'root', 'Algorithms', 'Materials/Algorithms'),
  ];
}

describe('normalizeFolderName', () => {
  it('trims and collapses internal whitespace', () => {
    expect(normalizeFolderName('  Data   Structures  ')).toBe('Data Structures');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeFolderName('   ')).toBe('');
  });
});

describe('validateFolderName', () => {
  it('accepts a normal name', () => {
    expect(validateFolderName('Week 3')).toEqual({ valid: true });
  });

  it('rejects an empty name', () => {
    expect(validateFolderName('   ').valid).toBe(false);
  });

  it('rejects a name containing the path separator', () => {
    expect(validateFolderName('a/b').valid).toBe(false);
  });

  it('rejects a case-insensitive duplicate sibling', () => {
    const result = validateFolderName('week 3', ['Week 3']);
    expect(result.valid).toBe(false);
  });

  it('allows a non-duplicate name among siblings', () => {
    expect(validateFolderName('Week 4', ['Week 3']).valid).toBe(true);
  });
});

describe('buildPath', () => {
  it('uses the normalized name for a root folder', () => {
    expect(buildPath(null, '  Materials ')).toBe('Materials');
  });

  it('joins parent path and child name with the separator', () => {
    const parent = node('ds', 'root', 'Data Structures', 'Materials/Data Structures');
    expect(buildPath(parent, 'Week 3')).toBe(
      `Materials${PATH_SEPARATOR}Data Structures${PATH_SEPARATOR}Week 3`
    );
  });
});

describe('getAncestors / isAncestor', () => {
  it('returns ancestors nearest-first', () => {
    const byId = indexById(sampleTree());
    const w3 = byId.get('w3') as FolderNode;
    expect(getAncestors(w3, byId).map((n) => n.id)).toEqual(['ds', 'root']);
  });

  it('returns no ancestors for a root', () => {
    const byId = indexById(sampleTree());
    expect(getAncestors(byId.get('root') as FolderNode, byId)).toEqual([]);
  });

  it('isAncestor is true for self and real ancestors, false otherwise', () => {
    const tree = sampleTree();
    const byId = indexById(tree);
    const w3 = byId.get('w3') as FolderNode;
    expect(isAncestor('w3', w3, byId)).toBe(true); // self
    expect(isAncestor('ds', w3, byId)).toBe(true);
    expect(isAncestor('root', w3, byId)).toBe(true);
    expect(isAncestor('algo', w3, byId)).toBe(false);
  });

  it('does not loop forever on a corrupt cyclic graph', () => {
    // a -> b -> a (cycle)
    const cyclic = [
      node('a', 'b', 'A', 'A'),
      node('b', 'a', 'B', 'B'),
    ];
    const byId = indexById(cyclic);
    // Should terminate and return a bounded chain.
    expect(getAncestors(byId.get('a') as FolderNode, byId).length).toBeLessThanOrEqual(2);
  });
});

describe('getChildren', () => {
  it('lists direct children sorted by name', () => {
    const tree = sampleTree();
    expect(getChildren('ds', tree).map((n) => n.id)).toEqual(['w1', 'w3']);
  });

  it('lists root folders when parentId is null', () => {
    const tree = sampleTree();
    expect(getChildren(null, tree).map((n) => n.id)).toEqual(['root']);
  });

  it('returns empty for a leaf', () => {
    expect(getChildren('w1', sampleTree())).toEqual([]);
  });
});

describe('getDescendants / getSubtree', () => {
  it('returns all descendants excluding the root', () => {
    const ids = getDescendants('root', sampleTree()).map((n) => n.id).sort();
    expect(ids).toEqual(['algo', 'ds', 'w1', 'w3']);
  });

  it('getSubtree includes the root first', () => {
    const subtree = getSubtree('ds', sampleTree()).map((n) => n.id);
    expect(subtree[0]).toBe('ds');
    expect(subtree.slice(1).sort()).toEqual(['w1', 'w3']);
  });

  it('returns empty subtree for an unknown id', () => {
    expect(getSubtree('nope', sampleTree())).toEqual([]);
  });
});

describe('validateCreate', () => {
  it('accepts a new unique folder under an existing parent', () => {
    expect(validateCreate('ds', 'Week 4', STUDENT, sampleTree()).valid).toBe(true);
  });

  it('rejects when the parent does not exist', () => {
    expect(validateCreate('ghost', 'X', STUDENT, sampleTree()).valid).toBe(false);
  });

  it('rejects a duplicate sibling', () => {
    expect(validateCreate('ds', 'Week 3', STUDENT, sampleTree()).valid).toBe(false);
  });

  it("rejects when the parent belongs to another student", () => {
    const tree = sampleTree();
    expect(validateCreate('ds', 'Week 4', 'other-student', tree).valid).toBe(false);
  });
});

describe('validateMove', () => {
  it('allows moving a folder to a different valid parent', () => {
    expect(validateMove('w3', 'algo', sampleTree()).valid).toBe(true);
  });

  it('rejects moving a folder into itself', () => {
    expect(validateMove('ds', 'ds', sampleTree()).valid).toBe(false);
  });

  it('rejects moving a folder into its own descendant', () => {
    expect(validateMove('ds', 'w3', sampleTree()).valid).toBe(false);
  });

  it('rejects a move that would clash with a destination sibling name', () => {
    const tree = sampleTree();
    // Add a "Week 3" directly under algo so moving ds's w3 there collides.
    tree.push(node('algo-w3', 'algo', 'Week 3', 'Materials/Algorithms/Week 3'));
    expect(validateMove('w3', 'algo', tree).valid).toBe(false);
  });

  it('allows promoting a folder to root', () => {
    expect(validateMove('w3', null, sampleTree()).valid).toBe(true);
  });
});

describe('planMove', () => {
  it('recomputes paths for the moved node and all descendants', () => {
    const updates = planMove('ds', 'algo', sampleTree());
    const byId = new Map(updates.map((u) => [u.id, u.path]));
    expect(byId.get('ds')).toBe('Materials/Algorithms/Data Structures');
    expect(byId.get('w1')).toBe('Materials/Algorithms/Data Structures/Week 1');
    expect(byId.get('w3')).toBe('Materials/Algorithms/Data Structures/Week 3');
  });

  it('throws for an invalid move', () => {
    expect(() => planMove('ds', 'w3', sampleTree())).toThrow();
  });
});

describe('planRename', () => {
  it('recomputes paths for the renamed node and descendants', () => {
    const updates = planRename('ds', 'DS', sampleTree());
    const byId = new Map(updates.map((u) => [u.id, u.path]));
    expect(byId.get('ds')).toBe('Materials/DS');
    expect(byId.get('w3')).toBe('Materials/DS/Week 3');
  });

  it('throws on a duplicate sibling name', () => {
    expect(() => planRename('ds', 'Algorithms', sampleTree())).toThrow();
  });
});

describe('planDelete', () => {
  it('returns the node and all descendant ids', () => {
    expect(planDelete('ds', sampleTree()).sort()).toEqual(['ds', 'w1', 'w3']);
  });

  it('returns empty for an unknown id', () => {
    expect(planDelete('nope', sampleTree())).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Property-based tests over randomly generated valid folder trees.    *
 * ------------------------------------------------------------------ */

/**
 * Generates a random, well-formed folder tree: a single root plus N nodes each
 * attached to a previously generated node, with correctly materialized paths.
 * This guarantees the acyclic, connected adjacency list the real data layer
 * maintains.
 */
const treeArb: fc.Arbitrary<FolderNode[]> = fc
  .array(
    fc.record({
      name: fc
        .stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ]{0,11}$/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
      // Attach to one of the already-created nodes, chosen by fractional index.
      parentPick: fc.double({ min: 0, max: 0.999, noNaN: true }),
    }),
    { minLength: 0, maxLength: 25 }
  )
  .map((specs) => {
    const root = node('root', null, 'Materials', 'Materials');
    const nodes: FolderNode[] = [root];
    specs.forEach((spec, i) => {
      const parent = nodes[Math.floor(spec.parentPick * nodes.length)];
      const id = `n${i}`;
      // Make the name unique among siblings by suffixing the id, dodging the
      // duplicate-sibling rule so generated trees are always valid. Normalize
      // the name the same way the helper does so the fixture's materialized
      // path matches buildPath()'s contract exactly.
      const name = normalizeFolderName(`${spec.name} ${id}`);
      nodes.push(node(id, parent.id, name, buildPath(parent, name)));
    });
    return nodes;
  });

describe('property: every non-root node has exactly one existing parent (no orphans/cycles)', () => {
  it('holds for generated trees', () => {
    fc.assert(
      fc.property(treeArb, (nodes) => {
        const byId = indexById(nodes);
        const roots = nodes.filter((n) => n.parentId === null);
        if (roots.length !== 1) return false;
        return nodes.every((n) => {
          if (n.parentId === null) return true;
          const parent = byId.get(n.parentId);
          if (!parent) return false;
          // No node is its own ancestor.
          return !isAncestor(n.id, parent, byId);
        });
      }),
      { numRuns: 100 }
    );
  });
});

describe('property: a node path equals its parent path joined with its name', () => {
  it('holds after planMove for the moved node and descendants', () => {
    fc.assert(
      fc.property(treeArb, fc.double({ min: 0, max: 0.999, noNaN: true }), fc.double({ min: 0, max: 0.999, noNaN: true }), (nodes, pickNode, pickParent) => {
        if (nodes.length < 2) return true;
        const movable = nodes.filter((n) => n.parentId !== null);
        if (movable.length === 0) return true;
        const target = movable[Math.floor(pickNode * movable.length)];
        const candidate = nodes[Math.floor(pickParent * nodes.length)];

        if (!validateMove(target.id, candidate.id, nodes).valid) {
          // Skip invalid picks — covered by the validation property below.
          return true;
        }
        const updates = planMove(target.id, candidate.id, nodes);
        const newPathById = new Map(updates.map((u) => [u.id, u.path]));

        // Build the post-move node set.
        const moved = nodes.map((n) => {
          const p = newPathById.get(n.id);
          if (n.id === target.id) {
            return { ...n, parentId: candidate.id, path: p ?? n.path };
          }
          return p ? { ...n, path: p } : n;
        });
        const byId = indexById(moved);

        // Every updated node's path must equal parent.path + "/" + name.
        return updates.every(({ id }) => {
          const n = byId.get(id) as FolderNode;
          const parent = n.parentId === null ? null : byId.get(n.parentId) ?? null;
          return n.path === buildPath(parent, n.name);
        });
      }),
      { numRuns: 100 }
    );
  });
});

describe('property: moving a folder into its own subtree is always rejected', () => {
  it('holds for generated trees', () => {
    fc.assert(
      fc.property(treeArb, fc.double({ min: 0, max: 0.999, noNaN: true }), (nodes, pick) => {
        if (nodes.length < 2) return true;
        const target = nodes[Math.floor(pick * nodes.length)];
        // Every descendant (and the node itself) is an invalid destination.
        const forbidden = [target, ...getDescendants(target.id, nodes)];
        return forbidden.every(
          (dest) => validateMove(target.id, dest.id, nodes).valid === false
        );
      }),
      { numRuns: 100 }
    );
  });
});

describe('property: planDelete returns exactly the subtree, no more no less', () => {
  it('holds for generated trees', () => {
    fc.assert(
      fc.property(treeArb, fc.double({ min: 0, max: 0.999, noNaN: true }), (nodes, pick) => {
        if (nodes.length === 0) return true;
        const target = nodes[Math.floor(pick * nodes.length)];
        const deleted = new Set(planDelete(target.id, nodes));
        const expected = new Set(getSubtree(target.id, nodes).map((n) => n.id));
        if (deleted.size !== expected.size) return false;
        for (const id of expected) {
          if (!deleted.has(id)) return false;
        }
        // The target must be included; nothing outside the subtree may be.
        if (!deleted.has(target.id)) return false;
        const ancestors = getAncestors(target, indexById(nodes));
        return ancestors.every((a) => !deleted.has(a.id));
      }),
      { numRuns: 100 }
    );
  });
});

describe('property: getChildren partitions nodes by parent exactly once', () => {
  it('holds for generated trees', () => {
    fc.assert(
      fc.property(treeArb, (nodes) => {
        const allParentIds = new Set<string | null>([null, ...nodes.map((n) => n.id)]);
        const collected: string[] = [];
        for (const pid of allParentIds) {
          for (const child of getChildren(pid, nodes)) {
            collected.push(child.id);
          }
        }
        // Every node appears exactly once as some parent's child (root under null).
        const counts = new Map<string, number>();
        for (const id of collected) counts.set(id, (counts.get(id) ?? 0) + 1);
        return (
          collected.length === nodes.length &&
          nodes.every((n) => counts.get(n.id) === 1)
        );
      }),
      { numRuns: 100 }
    );
  });
});
