import fc from 'fast-check';

/**
 * Scaffolding smoke tests. These confirm the toolchain is wired correctly:
 * - Jest executes TypeScript tests via ts-jest
 * - fast-check (property-based testing) is importable and runs
 */
describe('toolchain smoke test', () => {
  it('runs a TypeScript unit test', () => {
    const add = (a: number, b: number): number => a + b;
    expect(add(2, 3)).toBe(5);
  });

  it('runs a fast-check property (addition is commutative)', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => a + b === b + a),
      { numRuns: 100 }
    );
  });
});
