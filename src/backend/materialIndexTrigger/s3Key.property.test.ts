import fc from 'fast-check';
import { encodeS3EventKey } from './__tests__/fakes';
import { METADATA_SIDECAR_SUFFIX, parseS3EventKey } from './s3Key';

/**
 * Task 4.6 — property test for materialIndexTrigger key parsing.
 *
 * For any Materials key in either layout (arbitrary nesting, file and folder
 * names with spaces, `+`, `%`, `:`, punctuation and non-ASCII letters), parsing
 * the key exactly as an S3 event notification encodes it recovers the stored
 * key, owner segment, folder path and file name; the trigger's own metadata
 * sidecars and keys outside `materials/` are always ignored.
 *
 * Validates: Requirements 7.6
 */

const NAME_CHARS = 'abcXYZ019 +%:&=?#()[]!~_-.'.split('').concat(['ă', 'ș', 'ț', 'é', '中']);

const nameArb = fc.stringOf(fc.constantFrom(...NAME_CHARS), { minLength: 1, maxLength: 12 });

const fileNameArb = fc
  .tuple(nameArb, fc.constantFrom('pdf', 'pptx', 'txt', 'md', 'docx', 'xlsx', 'png', 'jpg'))
  .map(([base, extension]) => `${base}.${extension}`);

const ownerArb = fc.oneof(
  fc
    .tuple(fc.constantFrom('eu-central-1', 'us-east-1'), fc.uuid())
    .map(([region, id]) => ({ layout: 'private' as const, owner: `${region}:${id}` })),
  fc.uuid().map((id) => ({ layout: 'students' as const, owner: id }))
);

interface GeneratedMaterial {
  owner: { layout: 'private' | 'students'; owner: string };
  folders: string[];
  fileName: string;
}

const materialArb: fc.Arbitrary<GeneratedMaterial> = fc.record({
  owner: ownerArb,
  folders: fc.array(nameArb, { maxLength: 6 }),
  fileName: fileNameArb,
});

function keyOf({ owner, folders, fileName }: GeneratedMaterial, area = 'materials'): string {
  return [owner.layout, owner.owner, area, ...folders, fileName].join('/');
}

describe('materialIndexTrigger key parsing (property)', () => {
  it('recovers owner, folder path and file name from S3-encoded event keys', () => {
    fc.assert(
      fc.property(materialArb, (material) => {
        const key = keyOf(material);
        const result = parseS3EventKey(encodeS3EventKey(key));
        expect(result).toEqual({
          ok: true,
          value: {
            key,
            layout: material.owner.layout,
            ownerSegment: material.owner.owner,
            folderSegments: material.folders,
            folderPath: material.folders.join('/'),
            fileName: material.fileName,
          },
        });
      }),
      { numRuns: 200 }
    );
  });

  it('always ignores metadata sidecars, whatever the document key', () => {
    fc.assert(
      fc.property(materialArb, (material) => {
        const sidecarKey = `${keyOf(material)}${METADATA_SIDECAR_SUFFIX}`;
        expect(parseS3EventKey(encodeS3EventKey(sidecarKey))).toEqual({
          ok: false,
          reason: 'metadata-sidecar',
        });
      }),
      { numRuns: 200 }
    );
  });

  it('ignores keys outside a materials/ area', () => {
    fc.assert(
      fc.property(
        materialArb,
        fc.constantFrom('timetables', 'uploads', 'Materials', 'material'),
        (material, area) => {
          const key = keyOf(material, area);
          expect(parseS3EventKey(encodeS3EventKey(key))).toEqual({
            ok: false,
            reason: 'outside-materials',
          });
        }
      ),
      { numRuns: 100 }
    );
  });
});
