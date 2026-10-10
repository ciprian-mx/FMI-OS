/**
 * Minimal inline Lottie animation data for the boot sequence.
 *
 * This is a tiny, self-contained placeholder animation (a single shape fading
 * in over ~90 frames at 30fps ≈ 3 seconds) so that the BootAnimation component
 * has no dependency on any external asset outside the FMI OS workspace. A richer
 * branded animation can be dropped in later by replacing this export.
 *
 * The shape of this object follows the Lottie (Bodymovin) JSON schema. It is
 * deliberately kept small — the exact visual is unimportant; what matters is
 * that `lottie-react` can parse it and emit a `complete` event when playback
 * finishes.
 */
export const bootAnimationData = {
  v: '5.7.4',
  fr: 30,
  ip: 0,
  op: 90,
  w: 512,
  h: 512,
  nm: 'FMI OS Boot',
  ddd: 0,
  assets: [],
  layers: [
    {
      ddd: 0,
      ind: 1,
      ty: 4,
      nm: 'logo',
      sr: 1,
      ks: {
        o: {
          a: 1,
          k: [
            { t: 0, s: [0], h: 0 },
            { t: 45, s: [100], h: 0 },
            { t: 90, s: [100], h: 0 },
          ],
        },
        r: { a: 0, k: 0 },
        p: { a: 0, k: [256, 256, 0] },
        a: { a: 0, k: [0, 0, 0] },
        s: { a: 0, k: [100, 100, 100] },
      },
      ao: 0,
      shapes: [
        {
          ty: 'gr',
          it: [
            {
              ty: 'el',
              p: { a: 0, k: [0, 0] },
              s: { a: 0, k: [160, 160] },
            },
            {
              ty: 'fl',
              c: { a: 0, k: [0.2, 0.55, 0.95, 1] },
              o: { a: 0, k: 100 },
            },
            {
              ty: 'tr',
              p: { a: 0, k: [0, 0] },
              a: { a: 0, k: [0, 0] },
              s: { a: 0, k: [100, 100] },
              r: { a: 0, k: 0 },
              o: { a: 0, k: 100 },
            },
          ],
        },
      ],
      ip: 0,
      op: 90,
      st: 0,
      bm: 0,
    },
  ],
};

export default bootAnimationData;
