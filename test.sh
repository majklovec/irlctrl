curl "http://localhost:8090/overlay/alert/subscribe?token=6496c836fe43f76acdb2d9cc4440de5e&title=Novej+sub&message=Jana1"
curl "http://localhost:8090/overlay/alert/subscribe?token=6496c836fe43f76acdb2d9cc4440de5e&title=Novej+sub&message=Jana2"
curl "http://localhost:8090/overlay/alert/subscribe?token=6496c836fe43f76acdb2d9cc4440de5e&title=Novej+sub&message=Jana3"

curl "http://localhost:8090/overlay/variables/?token=6496c836fe43f76acdb2d9cc4440de5e&goal=0"
sleep 1
curl "http://localhost:8090/overlay/variables/?token=6496c836fe43f76acdb2d9cc4440de5e&goal=20"
sleep 1
curl "http://localhost:8090/overlay/variables/?token=6496c836fe43f76acdb2d9cc4440de5e&goal=40"
sleep 1
curl "http://localhost:8090/overlay/variables/?token=6496c836fe43f76acdb2d9cc4440de5e&goal=60"
sleep 1
curl "http://localhost:8090/overlay/variables/?token=6496c836fe43f76acdb2d9cc4440de5e&goal=80"
sleep 1
