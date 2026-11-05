# dsh-speech-whisper

A local **Whisper** speech-to-text provider plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

> **Statut : squelette.** Le greffon s'enregistre sur le seam `speechToText` et apparaît dans l'interface vocale.
> La transcription n'est pas encore branchée : la carte de portage est dans [docs/PORTING.md](docs/PORTING.md).

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

## Licence

MIT, comme le harnais lui-même : un greffon d'écosystème n'a pas à imposer une licence plus stricte que l'hôte.
