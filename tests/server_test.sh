#!/bin/bash
# Test direct du script Google (sans l'application)
URL=$(grep -o 'https://script.google.com/macros/s/[^"]*' ../android/app/src/main/java/ma/sonicod/operations/Core.kt | head -1)
KEY=$(grep -o 'SNC-[a-f0-9]*' ../android/app/src/main/java/ma/sonicod/operations/Core.kt | head -1)
call() { curl -sL -m 120 -H 'Content-Type: text/plain' -d "$1" "$URL"; echo; }
echo "== ping";            call "{\"action\":\"ping\",\"key\":\"$KEY\"}"
echo "== mauvaise clé";    call "{\"action\":\"ping\",\"key\":\"x\"}"
echo "== config";          call "{\"action\":\"config\",\"key\":\"$KEY\"}"
IMG=$(base64 -w0 test.jpg)
D2=$(date -d '-2 day' +%F); D0=$(date +%F); OP="srv-$(date +%s)"
echo "== submit avec photo"
call "{\"action\":\"submit\",\"key\":\"$KEY\",\"who\":\"TEST\",\"op\":{\"opId\":\"$OP-test\",\"livreur\":\"CASA\",\"colis\":2,\"dateReception\":\"$D0\",\"dateEnvoi\":\"$D2\",\"note\":\"TEST CLAUDE SERVEUR – A SUPPRIMER\",\"statut\":\"VALIDER\"},\"photos\":[{\"b64\":\"$IMG\"}]}"
echo "== submit (doublon attendu)"
call "{\"action\":\"submit\",\"key\":\"$KEY\",\"op\":{\"opId\":\"$OP-test\",\"livreur\":\"CASA\",\"colis\":2,\"dateReception\":\"$D0\",\"dateEnvoi\":\"$D2\",\"note\":\"x\",\"statut\":\"VALIDER\"},\"photos\":[]}"
echo "== submit invalide (date envoi après réception)"
call "{\"action\":\"submit\",\"key\":\"$KEY\",\"op\":{\"opId\":\"$OP-bad1\",\"livreur\":\"CASA\",\"colis\":2,\"dateReception\":\"$D2\",\"dateEnvoi\":\"$D0\",\"statut\":\"VALIDER\"}}"
echo "== scan"
call "{\"action\":\"scan\",\"key\":\"$KEY\",\"tracking\":\"TESTSRV$(date +%s)\",\"scanId\":\"$OP-scan1\"}"
echo "== lecture étiquette (OCR)"
LB=$(base64 -w0 label.jpg)
call "{\"action\":\"ocrLabel\",\"key\":\"$KEY\",\"b64\":\"$LB\"}"
