# Carte de portage

Le squelette enregistre un fournisseur `whisper` sur le seam et s'arrête là. Ce document dit exactement ce
qu'il reste à porter, et d'où cela vient.

Source : branche `feat/voice-input-french-whisper`, commit `c4af8f3096` du fork `XtremXpert/deepseek-harness`,
prise sur la base du 2 novembre 2026. L'amont a depuis renommé `speech-to-text-local` en
`speech-to-text-sensevoice` et l'a réduit à SenseVoice : le code ci-dessous n'a donc pas de successeur direct.

## Fichiers à porter

| Dans la branche d'origine | Ici | Ce qu'il contient |
|---|---|---|
| `speech-to-text-local/runtime/assets.json` (+68) | `src/assets.json` | Modèles Whisper : dépôt, révision, taille, SHA-256, répartition INT8/FP32 |
| `speech-to-text-local/src/inference.ts` (+146) | `src/runtime/inference.ts` | Boucle de décodage sherpa-onnx, extraction du texte et des durées |
| `speech-to-text-local/src/input.ts` (+40) | `src/runtime/input.ts` | Validation WAV, langues acceptées, rééchantillonnage |
| `speech-to-text-local/src/recognizer.ts` (+106/−63) | `src/runtime/recognizer.ts` | Sélection du modèle selon la langue, cycle de vie du worker |
| `speech-to-text-local/src/runtime.ts` (+79/−35) | `src/runtime/process.ts` | Sous-processus managé, réveil, file bornée, inactivité |
| `speech-to-text-local/src/worker.ts` (+8/−2) | `src/runtime/worker.ts` | Protocole du worker (boucle locale authentifiée) |
| `speech-to-text-local/src/config.ts` (+5/−2) | `src/config.ts` | `modelDirectory`, `precision`, `threads`, délais |
| `speech-to-text-local/tests/*.spec.ts` | `src/runtime/__tests__/` | Tests d'inférence, d'installateur, de langue, d'erreur de téléchargement |
| `speech-to-text-local/locale/*.json` | `locale/` | Libellés d'interface, dont `fr.json` |

## Ce qui doit rester vrai

Le fournisseur officiel impose des règles que le portage ne doit pas contourner :

1. **Aucun téléchargement à l'activation.** La préparation est explicite, déclenchée par l'utilisateur.
2. **Intégrité vérifiée.** Taille et SHA-256 épinglés, révision fixe, sources ordonnées sans repli silencieux.
3. **Annulation jointe.** Annuler une transcription termine le worker et joint son processus.
4. **Aucun repli.** Un échec local ne doit jamais envoyer l'audio ailleurs.

## Ordre de travail

1. Porter `assets.json` et `input.ts` — sans runtime, ils se testent seuls.
2. Porter `process.ts` et `worker.ts`, avec le protocole de boucle locale.
3. Porter `inference.ts` et `recognizer.ts`, puis brancher `transcribe()` dans `src/provider.ts`.
4. Implémenter `preparation` (interface `SpeechPreparation` du seam) : `snapshot`, `subscribe`, `prepare`,
   `cancel`. Tant qu'elle est absente, l'interface n'affiche aucune étape de préparation.
5. Reprendre les tests d'origine, puis vérifier le français de bout en bout.

## Dépendances

- `sherpa-onnx-node` fournit ONNX Runtime et les modèles Whisper : même runtime que le fournisseur officiel,
  donc aucun binaire nouveau.
- `@deepseek-ai/cordis` est la seule dépendance de pair. Le contrat du seam est recopié dans `src/contract.ts`
  parce que le paquet correspondant n'est pas publié.
