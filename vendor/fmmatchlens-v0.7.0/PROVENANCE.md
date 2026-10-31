# Provenance of vendored FMMatchLens sources

- Upstream: https://github.com/osnsyc/FMMatchLens, tag `v0.7.0` (annotated tag object `99b5e2f0812fb67b563a9569ee2a8f5c39782da7`)
- Fetched from `https://raw.githubusercontent.com/osnsyc/FMMatchLens/v0.7.0/<path>` on 2026-10-30
- License: MIT, Copyright (c) 2026 osnsyc (see `LICENSE` in this directory). Retain it with any reuse.
- Status: **untrusted reference data**. Nothing in this directory is executed. The one file that was deliberately adapted is
  `frontend/src/api/archiveParser.ts`, copied to `scripts/audit/lib/archiveParser.ts` (together with `lib/ratingCalculator.ts` and
  `types/match.ts`), where only import specifiers were rewritten (`@/x` to `./x.ts`) so Node's type stripping can run them.
  Logic is byte-identical otherwise (verified with `diff`).

SHA-256 of the fetched files:

```
6a1ce1862c2f00e5623afe769abe7c5e699ece417cf2f3c8fb5ac3ea29add509  LICENSE
4de94568973731fc2a0ccb4c27fb615cf64d2974ee57a26024143664e4f718b7  frontend/src/api/archiveParser.ts
e9c324c42afe2e26f0336cc8bc25d7a6ab35bbd1f3777a2360e2fa24ca264b99  frontend/src/api/momentumEventSemantics.ts
9fb2bac7d8e254ce54bc99eeb462271320652773eaf3bb19db5be477ec3f4fde  frontend/src/api/passMap.ts
4a3c72dab499bb795e607c17ecf9cf3c5fc4b795fed83616b8d0571581e33da0  frontend/src/api/realtimeMatch.ts
d241156f3899ad844da34f1e10828dd7eb592100c594ced5836c7921ff4d6f87  frontend/src/api/replay/replayDerivations.ts
3d650975ccd1bc21c747044cfbf4b583f1f134c45d1593d99698f754ead7e709  frontend/src/lib/ratingCalculator.ts
3080aad266472256432fac0f9d5be67a999b6cb0941115fa914555f2b523ce9f  frontend/src/types/match.ts
99296530568e89f522b99bd7fc4252d3e9e64a0246370b6a96b0d40973107f18  src/FMMatchLens.Plugin/Memory/GameMatchTickHook.cs
12373e2fd3fbe11078f550b2cb5de8541ef46a435146e6fd7802e8f17073d674  src/FMMatchLens.Plugin/Memory/NativeMomentumSource.cs
e0e2b56a99f521c0fafae1140848738d059cb9b6071d367b48d4735eef8f98ef  src/FMMatchLens.Plugin/Memory/PlayerUidReader.cs
90ceea25f59b9920d02d4f4c10183ee6a0607e1f33ad918e05c12021c44d0ff0  src/FMMatchLens.Plugin/Services/ArchiveFormat.cs
a3cef836ac3f69e0bfd707eea4ba1e70f251bb7a3a3da303215a4b1604c7bfa6  src/FMMatchLens.Plugin/Services/ArchiveFrameCodec.cs
aa86d834ef0e6e067525a4c63ab97320c3acca398c59c1262e481199cdacae6c  src/FMMatchLens.Plugin/Services/ArchiveWriter.cs
f73092374c3c489f4818b0f22e0aa1f0c6cf6e4bb87d746d47ed336753c6f52a  src/FMMatchLens.Plugin/Services/MatchArchiveStore.cs
690d2ae0df248fec3603e8f65a427f0ee9cf59b68d3bad9f7faf12d9b008b69d  src/FMMatchLens.Plugin/Services/MomentumEventReconciler.cs
d6c0977b50242d1d305d5e67b41e5484c06d5effb7bd995168eb5c0f29d6a87e  src/FMMatchLens.Plugin/Services/RealtimeMatchTimeline.cs
```

Not fetched: `LocalApiServer.cs`, `WebSocketHub.cs` (live-API phase, Slice 5).
