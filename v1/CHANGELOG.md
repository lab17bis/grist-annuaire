# Journal des modifications

Les adresses `/v1/` ne changent pas : chaque version ajoute ou corrige, sans retirer ce qui existe.

## 2026-11-27 (adresse refusée)
- Publication : une adresse de page contenant l'identifiant long du document est refusée avec un message qui explique quoi copier (Grist ignore la page dans ce cas).

## 2026-11-27 (barre stable)
- Barre de réglages : la place du bouton Enregistrer est réservée sur l'onglet de la vue, la barre ne saute plus d'un onglet à l'autre.

## 2026-11-27 (publication réservée)

### Ajouté

- Onglet Publication : section « Lien réservé aux personnes invitées » (collez l'adresse de la page Grist, le lien plein écran se construit, au choix en consultation seule ou avec saisie) et rappel de la différence entre page publique et lien réservé.

## 2026-11-27 (cohérence de la barre de réglages)

### Corrigé

- Le bouton Enregistrer est aligné sur la barre d'onglets, les onglets sont centrés et la pastille « Enregistré / Non enregistré » reste visible sur toutes les pages.

## 2026-11-26 (tables déjà présentes dans le document)

### Ajouté
- Le bandeau « Le document peut être complété » conseille de renommer d'abord une colonne existante qui porte la même information sous un autre nom (par exemple `Mail` au lieu de `Email`) : ses données sont alors reprises au lieu d'être ignorées.

## 2026-11-26 (style commun de configuration)

### Corrigé
- Configuration : sur l'onglet de l'outil, le style commun masquait par erreur tout champ dont l'identifiant finit par « -etat » (dans grist-projet : le filtre « État » de la banque et la liste « État » du formulaire de projet). Seul le badge « Enregistré » de la barre est maintenant masqué. Rien à refaire : rechargez la page.

## 2026-11-25 (première version)

### Ajouté
- Annuaire des personnes : recherche (nom, courriel, fonction, structure, champs personnalisés, sans accents ni majuscules), filtres, tri, 50 personnes par page.
- Fiches : création, modification, archivage, réactivation, « Ma fiche » (personne reconnue par l'adresse de son compte Grist).
- Structures en arborescence (structure, services, équipes) avec leurs membres.
- Champs prévus (fonction, téléphone fixe et portable professionnels) et champs personnalisés (texte, liste de choix, choix multiples, date, nombre, case).
- Doublons probables et fusion : références réécrites dans tout le document, fiche fusionnée archivée avec un renvoi, noms écrits en texte signalés et remplaçables un à un.
- Import d'un fichier CSV avec correspondance des colonnes et aperçu avant écriture.
- Protection des données : mention d'information, délai de conservation après archivage (12 mois par défaut), « Apparaît dans », export des données d'une personne, suppression qui vide les références.
- Rôle « gestionnaire de l'annuaire » et règles d'accès Grist installées par le widget ; règles existantes d'autres outils gardées et complétées.
- Mention discrète en pied de page : « Widget conçu par le Lab 17 bis, le laboratoire d'innovation publique de l'académie de Reims ».
- Reprise des tables `Personnes` et `Structures` existantes (variantes de grist-projet et de l'espace communauté) : seules les colonnes manquantes sont ajoutées.
