package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-gorp/gorp"
	"github.com/gorilla/websocket"
	"github.com/tevino/abool"

	"github.com/ovh/cds/engine/api/cache"
	"github.com/ovh/cds/engine/api/group"
	"github.com/ovh/cds/engine/api/observability"
	"github.com/ovh/cds/engine/api/permission"
	"github.com/ovh/cds/engine/service"
	"github.com/ovh/cds/sdk"
	"github.com/ovh/cds/sdk/log"
)

var upgrader = websocket.Upgrader{} // use default options

// websocketBrokerSubscribe is the information needed to subscribe
type websocketBrokerSubscribe struct {
	UUID    string
	User    *sdk.User
	isAlive *abool.AtomicBool
	conn    *websocket.Conn
	mutex   sync.Mutex
}

// lastUpdateBroker keeps connected client of the current route,
type websocketBroker struct {
	clients          map[string]*websocketBrokerSubscribe
	messages         chan sdk.Event
	dbFunc           func() *gorp.DbMap
	cache            cache.Store
	router           *Router
	chanAddClient    chan (*websocketBrokerSubscribe)
	chanRemoveClient chan (string)
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

func (b *websocketBroker) cacheSubscribe(c context.Context, cacheMsgChan chan<- sdk.Event, store cache.Store) {
	if cacheMsgChan == nil {
		return
	}

	pubSub := store.Subscribe("websocket_pubsub")
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-c.Done():
			if c.Err() != nil {
				log.Error("websocket.cacheSubscribe> Exiting: %v", c.Err())
				return
			}
		case <-tick.C:
			msg, err := store.GetMessageFromSubscription(c, pubSub)
			if err != nil {
				log.Warning("websocket.cacheSubscribe> Cannot get message %s: %s", msg, err)
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
			observability.Record(b.router.Background, b.router.Stats.SSEEvents, 1)
			cacheMsgChan <- e
		}
	}
}

// Start the broker
func (b *websocketBroker) Start(ctx context.Context, panicCallback func(s string) (io.WriteCloser, error)) {
	b.chanAddClient = make(chan *websocketBrokerSubscribe)
	b.chanRemoveClient = make(chan string)

	tickerMetrics := time.NewTicker(10 * time.Second)
	defer tickerMetrics.Stop()

	for {
		select {
		case <-tickerMetrics.C:
			observability.Record(b.router.Background, b.router.Stats.SSEClients, int64(len(b.clients)))

		case <-ctx.Done():
			if b.clients != nil {
				for uuid := range b.clients {
					delete(b.clients, uuid)
				}
				observability.Record(b.router.Background, b.router.Stats.SSEClients, 0)
			}
			if ctx.Err() != nil {
				log.Error("websocketBroker.Start> Exiting: %v", ctx.Err())
				return
			}

		case receivedEvent := <-b.messages:
			for i := range b.clients {
				c := b.clients[i]
				if c == nil {
					delete(b.clients, i)
					continue
				}

				// Send the event to the client sse within a goroutine
				s := "websocket-" + b.clients[i].UUID
				sdk.GoRoutine(ctx, s,
					func(ctx context.Context) {
						if c.isAlive.IsSet() {
							log.Debug("send data to %s", c.UUID)
							if err := c.Send(receivedEvent); err != nil {
								b.chanRemoveClient <- c.UUID
								msg := fmt.Sprintf("%v", err)
								for _, s := range handledEventErrors {
									if strings.Contains(msg, s) {
										// do not log knowned error
										return
									}
								}
								log.Error("websocketBroker> unable to send event to %s: %v", c.UUID, err)
							}
						}
					}, panicCallback,
				)
			}

		case client := <-b.chanAddClient:
			b.clients[client.UUID] = client

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

func (b *websocketBroker) ServeHTTP() service.Handler {
	return func(ctx context.Context, w http.ResponseWriter, r *http.Request) (err error) {
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Error("websocket: unable to create connection: %v", err)
			return
		}
		defer c.Close()

		// Create User
		user := deprecatedGetUser(ctx)
		if err := loadUserPermissions(b.dbFunc(), b.cache, user); err != nil {
			return sdk.WrapError(err, "websocketBroker.Serve Cannot load user permission")
		}

		uuid := sdk.UUID()
		client := &websocketBrokerSubscribe{
			UUID:    uuid,
			User:    user,
			isAlive: abool.NewBool(true),
			conn:    c,
		}

		// Add this client to the map of those that should receive updates
		b.chanAddClient <- client

		tick := time.NewTicker(time.Second)
		defer tick.Stop()

	leave:
		for {
			select {
			case <-ctx.Done():
				log.Debug("websocket.Http: context done")
				b.chanRemoveClient <- client.UUID
				break leave
			case <-r.Context().Done():
				log.Debug("websocket.Http: client disconnected")
				b.chanRemoveClient <- client.UUID
				break leave
			}
		}
		return nil
	}
}

func (client *websocketBrokerSubscribe) manageEvent(event sdk.Event) bool {
	var isSharedInfra bool
	for _, g := range client.User.Groups {
		if g.ID == group.SharedInfraGroup.ID {
			isSharedInfra = true
			break
		}
	}

	projectPermission := permission.ProjectPermission(event.ProjectKey, client.User)
	if strings.HasPrefix(event.EventType, "sdk.EventProject") {
		if client.User.Admin || isSharedInfra || projectPermission >= permission.PermissionRead {
			return true
		}
		return false
	}
	if strings.HasPrefix(event.EventType, "sdk.EventWorkflow") || strings.HasPrefix(event.EventType, "sdk.EventRunWorkflow") {
		if client.User.Admin || isSharedInfra || permission.WorkflowPermission(event.ProjectKey, event.WorkflowName, client.User) >= permission.PermissionRead {
			return true
		}
		return false
	}
	if strings.HasPrefix(event.EventType, "sdk.EventApplication") {
		if client.User.Admin || isSharedInfra || projectPermission >= permission.PermissionRead {
			return true
		}
		return false
	}
	if strings.HasPrefix(event.EventType, "sdk.EventPipeline") {
		if client.User.Admin || isSharedInfra || projectPermission >= permission.PermissionRead {
			return true
		}
		return false
	}
	if strings.HasPrefix(event.EventType, "sdk.EventEnvironment") {
		if client.User.Admin || isSharedInfra || projectPermission >= permission.PermissionRead {
			return true
		}
		return false
	}
	if strings.HasPrefix(event.EventType, "sdk.EventBroadcast") {
		if client.User.Admin || isSharedInfra || event.ProjectKey == "" || permission.AccessToProject(event.ProjectKey, client.User, permission.PermissionRead) {
			return true
		}
		return false
	}
	return false
}

// Send an event to a client
func (client *websocketBrokerSubscribe) Send(event sdk.Event) (err error) {
	client.mutex.Lock()
	defer client.mutex.Unlock()

	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("websocketBrokerSubscribe.Send recovered %v", r)
		}
	}()

	if client == nil || client.conn == nil || !client.isAlive.IsSet() || event.EventType == "" {
		return nil
	}

	if ok := client.manageEvent(event); !ok {
		return nil
	}

	msg, err := json.Marshal(event)
	if err != nil {
		return sdk.WrapError(err, "Unable to marshall event")
	}
	if err := client.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
		return sdk.WrapError(err, "websocket: unable to write to client")
	}
	return nil
}
