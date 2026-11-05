# dsh-speech-whisper

A local **Whisper** speech-to-text provider plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

> **Statut : porté, compile.** Le fournisseur Whisper du fork est repris ici et se construit contre le contrat du
> seam tel qu'il est dans DeepSeek Harness 0.2.2-rc.1. Reste à l'essayer en conditions réelles : téléchargement des
> modèles, worker `sherpa-onnx`, dictée française. Voir [docs/PORTING.md](docs/PORTING.md).

## Pourquoi ce greffon

Le fournisseur local livré avec le harnais reconnaît le chinois, l'anglais, le cantonais, le japonais et le
coréen — ses propres mots : *« Language hints are auto, Chinese, English, Cantonese, Japanese and Korean »*
(`packages/experimental/speech-to-text-sensevoice/README.md`). Le français n'y est pas.

Comme le seam ne prévoit **aucun repli** vers un autre fournisseur — un échec local ne doit jamais autoriser
l'envoi d'un enregistrement vers un service distant — un utilisateur francophone n'a aujourd'hui aucune dictée
locale. Ce greffon comble ce trou avec Whisper, qui couvre une centaine de langues sur le même runtime
`sherpa-onnx`, sans nouveau binaire et sans changer le seam.

## Ce que le greffon fait

- enregistre un fournisseur `whisper` sur le registre `ctx.speechToText` ;
- annonce ses langues, sa localisation (`host-local`) et son estimation d'installation ;
- se retire proprement quand le plugin est désactivé (le désabonnement rendu par `register()` est branché sur
  `ctx.effect`) ;
- ne télécharge rien à l'activation : la préparation reste explicite, comme pour le fournisseur officiel.

## Installation

```sh
# dans un profil DeepSeek Harness
dsh plugin add dsh-speech-whisper
```

Le paquet n'est pas encore publié : voir « Développement » ci-dessous.

## Développement

```sh
pnpm install
pnpm build        # tsc
pnpm typecheck
```

Le contrat du fournisseur est recopié dans `src/contract.ts` plutôt qu'importé : le paquet
`@deepseek-ai/dsh-experimental-speech-to-text` est expérimental et interne au monorepo du harnais. La copie
cite le fichier source et le commit dont elle est tirée — à revoir à chaque montée de version du seam.

## Essai hors interface

Le 5 novembre 2026, sur macOS arm64, avec les modèles Whisper small INT8 épinglés dans `runtime/assets.json` :

| | |
|---|---|
| Audio | 5,77 s, français, synthèse macOS (`Amelie`), WAV 16 kHz mono |
| Inférence | 1,53 s sur CPU, 2 fils |
| Texte | « Bonjour, ceci est un essai de dictée en français pour vérifier que le module Wisp fonctionne correctement. » |

Le seul écart est « Whisper », nom propre anglais, entendu « Wisp ». Cela valide les modèles, le runtime
`sherpa-onnx` et le français ; cela ne valide pas encore le chemin interne du greffon (worker managé, boucle
locale, préparation) — c'est l'étape suivante, dans l'interface.

## Licence

MIT, comme le harnais lui-même : un greffon d'écosystème n'a pas à imposer une licence plus stricte que l'hôte.
