# grist-annuaire

> **Widget-outil pour Grist, clé en main.** Il tient à jour les personnes et les structures d'un document Grist, au Système de design de l'État (DSFR) : recherche, fiches, arborescence des structures, champs personnalisés, doublons et fusion, import d'un fichier CSV, archivage et protection des données.

L'annuaire n'a pas de base à lui. Il gère les tables `Personnes` et `Structures` **du document où il est posé**, que les autres widgets du même document lisent aussi (projets, réunions, carte, graphe, management visuel). Il n'y a donc qu'une liste de personnes par document, sans doublon ni synchronisation. Deux documents différents ont deux annuaires différents.

Tout se règle dans Grist, sans toucher au code. Le dépôt ne contient que le code : aucune donnée réelle.

Démonstration avec des données fictives (rien n'est enregistré) : <https://lab17bis.github.io/grist-annuaire/v1/>

## À quoi ça sert

| Besoin | Ce que l'outil permet |
| --- | --- |
| **Retrouver quelqu'un** | Recherche sur le nom, le courriel, la fonction, la structure et les champs personnalisés, sans tenir compte des accents ni des majuscules. Filtres par structure (avec ses services), fonction, statut, champ personnalisé, personnes sans courriel, gestionnaires. 50 personnes par page, compteur annoncé aux lecteurs d'écran |
| **Tenir les fiches à jour** | Créer, modifier, archiver, réactiver. « Ma fiche » ouvre la fiche de la personne connectée, reconnue par l'adresse de son compte Grist |
| **Organiser les structures** | Arborescence (une structure, ses services, ses équipes), fiche avec ses membres et les endroits où elle est citée |
| **Ajouter ses propres champs** | Texte, texte long, liste de choix, choix multiples, date, nombre, case à cocher. Chaque champ devient une colonne de `Personnes` |
| **Nettoyer** | Doublons probables (même courriel, ou même nom sans accents ni ordre des mots). La fusion garde une fiche, y reporte toutes les références des autres tables, archive l'autre et garde un renvoi. Les noms écrits en texte (responsable d'une action de réunion, liens du graphe…) sont listés et se remplacent un à un |
| **Importer** | Un fichier CSV (point-virgule ou virgule) : correspondance des colonnes devinée puis modifiable, aperçu ligne par ligne (nouvelle, doublon probable, déjà présente, erreur), structures reconnues par nom ou sigle, création des structures inconnues. Rien n'est écrit avant validation. Le fichier est lu dans le navigateur |
| **Protéger les données** | Mention d'information réglable ; délai de conservation après archivage (12 mois par défaut) avec les fiches à supprimer ; « Apparaît dans » et export des données d'une personne (demande d'accès) ; suppression qui vide les références |

## Les droits

Les droits sont appliqués par les **règles d'accès de Grist**, pas par le widget. À l'installation, l'annuaire propose de les poser :

| Qui | Personnes | Structures |
| --- | --- | --- |
| Propriétaires du document | Tout | Tout |
| Gestionnaires de l'annuaire | Toutes les fiches, sauf celles des autres gestionnaires | Tout |
| Éditeurs | Consultent, créent des fiches, modifient la leur et celles qu'ils ont créées | Consultent |
| Lecteurs | Consultent | Consultent |
| Sans accès au document | Rien | Rien |

Le rôle **gestionnaire de l'annuaire** (case `Gestion_annuaire` d'une fiche) n'est attribué que par les propriétaires. Il repose sur un attribut utilisateur de Grist (`Profil_annuaire`) qui relie la personne connectée à sa fiche par le courriel.

Si les tables ont déjà des règles posées par un autre outil (par exemple grist-projet), elles sont gardées : l'annuaire y ajoute seulement les règles du rôle gestionnaire, juste avant la première règle qui accorde un droit.

**Pas de page publique.** L'annuaire contient des données personnelles : il s'utilise dans Grist, par les personnes invitées dans le document. Pour montrer des structures au public, utilisez [grist-carte](https://github.com/lab17bis/grist-carte) sur la table `Structures`.

## Le brancher en 3 minutes

1. **Ajouter le widget** : dans un document Grist, *Ajouter › Ajouter une page › Personnalisé*, sur n'importe quelle table. Choisissez *URL personnalisée*, saisissez `https://lab17bis.github.io/grist-annuaire/v1/` et donnez l'**accès complet au document**.
2. **Installer** :
   - document sans table `Personnes` : *Créer les tables* (ou *avec un exemple fictif*). Le widget crée `Personnes`, `Structures` et `Comptes`, puis les règles d'accès ;
   - document qui a déjà `Personnes` (grist-projet, espace communauté…) : un bandeau propose *Mettre le document à jour*. Seules les colonnes manquantes sont ajoutées ; rien n'est renommé, converti ni supprimé. Puis onglet *Réglages*, rubrique *Règles d'accès*.
3. **Inviter** les personnes dans le document (*Partager*) : éditeur pour qu'elles tiennent leur fiche, lecteur pour la consultation.

À faire par un propriétaire du document.

## Le régler

Barre d'onglets : *Annuaire* (l'outil), *Réglages*, *En-tête et pied*, *Aperçu* (l'annuaire réel avec les réglages en cours, même non enregistrés) et *Publication*. L'onglet *Réglages* regroupe :

| Rubrique | Ce qu'on y règle |
| --- | --- |
| Champs prévus | Fonction, téléphone fixe professionnel, téléphone portable professionnel (les deux téléphones sont désactivés par défaut) |
| Champs personnalisés | Libellé, type, valeurs possibles, masquer. Un champ masqué n'est jamais supprimé |
| Types de structures | Valeurs de la colonne `Structures.Type` |
| Protection des données | Délai de conservation après archivage (mois), mention d'information |
| Règles d'accès | État des règles de `Personnes`, `Structures` et `Comptes`, bouton pour les installer ou les compléter |

Les réglages sont enregistrés en JSON dans la **description de la colonne `Config_annuaire`** de la table `Personnes`. Ne supprimez pas cette colonne.

## Modèle de données

| Table | Colonnes utilisées |
| --- | --- |
| `Personnes` | `Nom`, `Email` (ou `Email_saisi` quand `Email` est une formule, comme dans grist-projet), `Structure` (référence), `Fonction`, `Archive`, `Archive_le`, `Fusionne_dans` (référence), `Gestion_annuaire`, `Cree_par`, `Cree_le`, `Telephone_fixe` et `Telephone_portable` (si activés), champs personnalisés, `Config_annuaire` |
| `Structures` | `Nom`, `Sigle`, `Type` (choix), `Parent` (référence), `Adresse`, `Courriel`, `Site` |
| `Comptes` | `Email` (rempli par Grist avec l'adresse de la personne connectée), `Cree_le` : sert à « Ma fiche » |

Les colonnes propres à d'autres outils (`Role` de grist-projet, `Groupes` de l'espace communauté…) sont lues quand elles existent et ne sont jamais modifiées.

## Le reprendre et l'adapter

- **L'héberger chez vous** : copiez le dépôt (*Fork*), activez GitHub Pages ou déposez les fichiers sur un serveur web statique, puis changez l'adresse du widget dans Grist. Aucune compilation.
- **Tests** : `python3 -m http.server 8790` à la racine, puis `python3 tests/test_annuaire.py` (Playwright).
- **Version stable** : `sh outils/figer-version.sh 1` copie le code servi dans `v1/`.

| Dossier ou fichier | Rôle |
| --- | --- |
| `index.html`, `js/app.js`, `css/app.css` | Le widget |
| `commun/` | Coque commune aux widgets de la famille (en-tête et pied DSFR, page de configuration) |
| `exemples/demo.json` | Données fictives de la démonstration et de l'exemple |
| `vendor/dsfr/` | Système de design de l'État |

## Limites

- Un widget ne peut pas envoyer de courriel ni de notification.
- La fusion réécrit les références (colonnes de type référence vers `Personnes`) de tout le document ; les noms écrits en texte ne sont que signalés. Une fusion qui touche d'autres tables que l'annuaire demande d'être propriétaire du document.
- La recherche et les filtres se font dans le navigateur : au-delà de quelques milliers de personnes, l'affichage ralentit.
- Aucun audit RGAA n'a été mené.

## Licence

MIT. Le Système de design de l'État est soumis à ses propres conditions d'utilisation.

Widget conçu par le Lab 17 bis, le laboratoire d'innovation publique de l'académie de Reims.
