# Journal des modifications

Les adresses `/v1/` ne changent pas : chaque version ajoute ou corrige, sans retirer ce qui existe.

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
