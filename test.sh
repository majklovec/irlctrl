# scratch debug script — replace <overlayId> with the overlay's id and
# <token> with the overlay owner's user token
curl "http://localhost:8090/overlay/<overlayId>/event/subscribe?token=<token>&title=Novej+sub&message=Jana1"
curl "http://localhost:8090/overlay/<overlayId>/event/subscribe?token=<token>&title=Novej+sub&message=Jana2"
curl "http://localhost:8090/overlay/<overlayId>/event/subscribe?token=<token>&title=Novej+sub&message=Jana3"
