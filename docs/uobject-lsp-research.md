# UObject / UHT Language Server Research

## Goal

Evaluate whether a custom LSP or clangd plugin can reach JetBrains Rider / ReSharper-level `UObject` reflection semantics for Unreal Engine C++.

## Rider / Resharper capabilities (target)

- Understands `UCLASS` / `UPROPERTY` / `UFUNCTION` as first-class symbols
- Resolves `GENERATED_BODY()` to generated members
- Blueprint-aware navigation (C++ ↔ BP nodes)
- Accurate type propagation through `TObjectPtr<>`, `TSubclassOf<>`, soft pointers

## clangd limitations

clangd is a **standard C++ LSP**. It:

- Expands macros but does not execute UHT
- Cannot load live `UObject` reflection at edit time without UE-specific index
- Treats `UPROPERTY` as opaque macros (mitigated by IDE stubs in UE5_8 Cursor)

## Options evaluated

| Approach | Effort | Fidelity | Recommendation |
|----------|--------|----------|----------------|
| UE5_8 Cursor reflection-index + CodeLens | Low | Medium | **Shipped (v4.x)** |
| clangd `-include` stubs + Intermediate `-I` | Low | Low–Medium | **Shipped** |
| Fork clangd with UHT AST plugin | Very High | High | Not justified for extension |
| Separate UE LSP (Rider-style) | Extreme | Very High | Epic/Rider internal scope |
| MCP + editor AssetRegistry for assets | Medium | High for assets | **Shipped (v4.x)** |

## Recommendation

1. **Do not fork clangd** for a VS Code extension.
2. Continue **extension-side indexes**: reflection-index, asset-index, MCP resolver.
3. Use **ReferenceProvider + CodeLens** for navigation gaps.
4. Revisit only if Epic ships a public UE-aware LSP or clangd plugin API stabilizes.

## UE5_8 Cursor explicit limits (document for users)

- clangd errors on generated code may remain suppressed, not truly "understood"
- BP node graph navigation requires editor MCP
- `.uasset` full parsing is intentionally shallow (header heuristic only in v5)
