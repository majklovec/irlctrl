#!/usr/bin/env bash
# scratch debug script — replace <overlayId> with the overlay's id and
# <token> with the overlay owner's user token
curl "http://localhost:8090/overlay/<overlayId>/variables?token=<token>&title=New+subscriber&message=Michasdsel"
