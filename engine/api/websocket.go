package api

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/ovh/cds/engine/service"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/tevino/abool"

	"github.com/ovh/cds/engine/api/cache"
	"github.com/ovh/cds/engine/api/observability"
	"github.com/ovh/cds/sdk"
	"github.com/ovh/cds/sdk/log"
)

var upgrader = websocket.Upgrader{} // use default options

type websocketClient struct {
	AuthConsumer *sdk.AuthConsumer
	isAlive      *abool.AtomicBool
	con          *websocket.Conn
	mutex        sync.Mutex
	messageChan  chan WebsocketMessage
}

type websocketBroker struct {
	clients          map[string]*websocketClient
	cache            cache.Store
	router           *Router
	messages         chan sdk.Event
	chanAddClient    chan *websocketClient
	chanRemoveClient chan string
}

type WebsocketMessage struct {
}

//Init the websocketBroker
func (b *websocketBroker) Init(ctx context.Context, panicCallback func(s string) (io.WriteCloser, error)) {
	// Start cache Subscription
	sdk.GoRoutine(ctx, "websocketBroker.Init.CacheSubscribe", func(ctx context.Context) {
		b.cacheSubscribe(ctx, b.messages, b.cache)
	}, panicCallback)

	sdk.GoRoutine(ctx, "websocketBroker.Init.Start", func(ctx context.Context) {
		b.Start(ctx, panicCallback)
	}, panicCallback)
}

// Start the broker
func (b *websocketBroker) Start(ctx context.Context, panicCallback func(s string) (io.WriteCloser, error)) {
	tickerMetrics := time.NewTicker(10 * time.Second)
	defer tickerMetrics.Stop()

	for {
		select {
		case <-tickerMetrics.C:
			observability.Record(b.router.Background, b.router.Stats.WebSocketClients, int64(len(b.clients)))
		case <-ctx.Done():
			if b.clients != nil {
				for uuid := range b.clients {
					delete(b.clients, uuid)
				}
				observability.Record(b.router.Background, b.router.Stats.WebSocketClients, 0)
			}
			if ctx.Err() != nil {
				log.Error("websocketBroker.Start> Exiting: %v", ctx.Err())
				return
			}

		case receivedEvent := <-b.messages:
			log.Warning("Received event: %+v", receivedEvent)
			for i := range b.clients {
				c := b.clients[i]
				if c == nil {
					delete(b.clients, i)
					continue
				}

				// Send the event to the client sse within a goroutine
				s := "websocket-" + b.clients[i].AuthConsumer.ID
				sdk.GoRoutine(ctx, s,
					func(ctx context.Context) {
						if c.isAlive.IsSet() {
							log.Debug("send data to %s", c.AuthConsumer.ID)
							if err := c.Send(receivedEvent); err != nil {
								b.chanRemoveClient <- c.AuthConsumer.ID
								log.Error("websocketBroker.Start> unable to send event to %s: %v", c.AuthConsumer.ID, err)
							}
						}
					}, panicCallback,
				)
			}

		case client := <-b.chanAddClient:
			b.clients[client.AuthConsumer.ID] = client

		case uuid := <-b.chanRemoveClient:
			client, has := b.clients[uuid]
			if !has {
				continue
			}

			client.isAlive.UnSet()
			delete(b.clients, uuid)
		}
	}
}

func (b *websocketBroker) cacheSubscribe(c context.Context, cacheMsgChan chan<- sdk.Event, store cache.Store) {
	if cacheMsgChan == nil {
		return
	}

	pubSub := store.Subscribe("events_pubsub")
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-c.Done():
			if c.Err() != nil {
				log.Error("websocketBroker.cacheSubscribe> Exiting: %v", c.Err())
				return
			}
		case <-tick.C:
			msg, err := store.GetMessageFromSubscription(c, pubSub)
			if err != nil {
				log.Warning("websocketBroker.cacheSubscribe> Cannot get message %s: %s", msg, err)
				continue
			}
			var e sdk.Event
			if err := json.Unmarshal([]byte(msg), &e); err != nil {
				// don't print the error as we doesn't care
				continue
			}

			switch e.EventType {
			case "sdk.EventJob":
				continue
			}
			observability.Record(b.router.Background, b.router.Stats.WebSocketEvents, 1)
			cacheMsgChan <- e
		}
	}
}

func (b *websocketBroker) ServeHTTP() service.Handler {
	return func(ctx context.Context, w http.ResponseWriter, r *http.Request) (err error) {
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Warning("upgrade:", err)
			return err
		}
		defer c.Close()

		log.Warning("WElcome")
		c.WriteMessage(websocket.TextMessage, []byte("Coucou"))
		client := websocketClient{
			AuthConsumer: getAPIConsumer(r.Context()),
			isAlive:      abool.NewBool(true),
			con:          c,
			messageChan:  make(chan WebsocketMessage, 10),
		}
		b.chanAddClient <- &client

		go client.read(r.Context())

		for {
			var msg WebsocketMessage
			if err := c.ReadJSON(msg); err != nil {
				log.Warning("websocket.readJSON: %v", err)
			}
			// Send message to client
			client.messageChan <- msg
		}
	}
}

func (c *websocketClient) read(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			log.Debug("events.Http: context done")
			return
		case m := <-c.messageChan:
			if err := c.UpdateEventFilter(m); err != nil {
				log.Error("websocketClient.read: unable to update event filter: %v", err)
				continue
			}
		}
	}
}

func (c *websocketClient) UpdateEventFilter(m WebsocketMessage) error {
	c.mutex.Lock()
	defer c.mutex.Unlock()

	return nil
}

// Send an event to a client
func (c *websocketClient) Send(event sdk.Event) (err error) {
	c.mutex.Lock()
	defer c.mutex.Unlock()
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("websocketClient.Send recovered %v", r)
		}
	}()

	if c == nil || c.con == nil || !c.isAlive.IsSet() {
		return nil
	}

	if err := c.con.WriteJSON(event); err != nil {
		log.Error("websocketClient.Send > unable to write json: %v", err)
	}
	return nil
}
