package api

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/go-gorp/gorp"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/tevino/abool"

	"github.com/ovh/cds/engine/api/cache"
	"github.com/ovh/cds/engine/api/observability"
	"github.com/ovh/cds/engine/api/permission"
	"github.com/ovh/cds/engine/service"
	"github.com/ovh/cds/sdk"
	"github.com/ovh/cds/sdk/log"
)

var upgrader = websocket.Upgrader{} // use default options

type websocketClient struct {
	UUID         string
	AuthConsumer *sdk.AuthConsumer
	isAlive      *abool.AtomicBool
	con          *websocket.Conn
	mutex        sync.Mutex
	filter       WebsocketFilter
	messageChan  chan WebsocketFilter
}

type websocketBroker struct {
	clients          map[string]*websocketClient
	cache            cache.Store
	dbFunc           func() *gorp.DbMap
	router           *Router
	messages         chan sdk.Event
	chanAddClient    chan *websocketClient
	chanRemoveClient chan string
}

type WebsocketFilter struct {
	ProjectKey        string `json:"project_key"`
	ApplicationName   string `json:"application_name"`
	PipelineName      string `json:"pipeline_name"`
	EnvironmentName   string `json:"environment_name"`
	WorkflowName      string `json:"workflow_name"`
	WorkflowRunNumber int64  `json:"workflow_run_num"`
	WorkflowNodeRunID int64  `json:"workflow_node_run_id"`
	Favorites         bool   `json:"favorites"`
}

type WebsocketEvent struct {
	Status string    `json:"status"`
	Error  string    `json:"error"`
	Event  sdk.Event `json:"event"`
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
			for i := range b.clients {
				c := b.clients[i]
				if c == nil {
					delete(b.clients, i)
					continue
				}

				// Send the event to the client workflow within a goroutine
				s := "websocket-" + b.clients[i].UUID
				sdk.GoRoutine(ctx, s,
					func(ctx context.Context) {
						if c.isAlive.IsSet() {
							log.Debug("send data to %s", c.AuthConsumer.AuthentifiedUser.Username)
							if err := c.send(receivedEvent); err != nil {
								b.chanRemoveClient <- c.UUID
								log.Error("websocketBroker.Start> unable to send event to %s: %v", c.AuthConsumer.AuthentifiedUser.Username, err)
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

		client := websocketClient{
			UUID:         sdk.UUID(),
			AuthConsumer: getAPIConsumer(r.Context()),
			isAlive:      abool.NewBool(true),
			con:          c,
			messageChan:  make(chan WebsocketFilter, 10),
		}
		b.chanAddClient <- &client

		go client.read(ctx, b.dbFunc())

		tick := time.NewTicker(100 * time.Millisecond)
		defer tick.Stop()
		for {
			var msg WebsocketFilter
			_, message, err := c.ReadMessage()
			if err != nil {
				if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
					log.Warning("websocket error: %v", err)
				}
				log.Warning("client disconnected")
				break
			}
			if err := json.Unmarshal(message, &msg); err != nil {
				log.Warning("websocket.readJSON: %v", err)
				continue
			}
			// Send message to client
			client.messageChan <- msg
		}
		return nil
	}
}

func (c *websocketClient) read(ctx context.Context, db *gorp.DbMap) {
	for {
		select {
		case <-ctx.Done():
			log.Debug("events.Http: context done")
			return
		case m := <-c.messageChan:
			if err := c.updateEventFilter(ctx, db, m); err != nil {
				log.Error("websocketClient.read: unable to update event filter: %v", err)
				msg := WebsocketEvent{
					Status: "KO",
					Error:  sdk.Cause(err).Error(),
				}
				_ = c.con.WriteJSON(msg)
				continue
			}
		}
	}
}

func (c *websocketClient) updateEventFilter(ctx context.Context, db gorp.SqlExecutor, m WebsocketFilter) error {
	c.mutex.Lock()
	defer c.mutex.Unlock()

	// Subscribe to project
	if m.ProjectKey != "" && m.WorkflowName == "" {
		perms, err := permission.LoadProjectMaxLevelPermission(ctx, db, []string{m.ProjectKey}, getAPIConsumer(ctx).GetGroupIDs())
		if err != nil {
			return err
		}
		maxLevelPermission := perms.Level(m.ProjectKey)
		if maxLevelPermission < sdk.PermissionRead && !isMaintainer(ctx) {
			return sdk.WithStack(sdk.ErrForbidden)
		}
		c.filter = m
	}

	// Subscribe to workflow
	if m.ProjectKey != "" && m.WorkflowName != "" {
		perms, err := permission.LoadWorkflowMaxLevelPermission(ctx, db, m.ProjectKey, []string{m.WorkflowName}, getAPIConsumer(ctx).GetGroupIDs())
		if err != nil {
			return err
		}
		maxLevelPermission := perms.Level(m.WorkflowName)
		if maxLevelPermission < sdk.PermissionRead && !isMaintainer(ctx) {
			return sdk.WithStack(sdk.ErrForbidden)
		}
		c.filter = m
	}

	return nil
}

// Send an event to a client
func (c *websocketClient) send(event sdk.Event) (err error) {
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

	if c.filter.Favorites {
		// TODO Check if event is on favorite
		return nil
	} else {
		if event.ProjectKey != c.filter.ProjectKey {
			return nil
		}
		if c.filter.EnvironmentName != "" && event.EnvironmentName != c.filter.EnvironmentName {
			return nil
		}
		if c.filter.PipelineName != "" && event.PipelineName != c.filter.PipelineName {
			return nil
		}
		if c.filter.ApplicationName != "" && event.ApplicationName != c.filter.ApplicationName {
			return nil
		}
		if c.filter.WorkflowName != "" && event.WorkflowName != c.filter.WorkflowName {
			return nil
		}
		if c.filter.WorkflowRunNumber != 0 && event.WorkflowRunNum != c.filter.WorkflowRunNumber {
			return nil
		}
		// TODO check node run event
	}

	msg := WebsocketEvent{
		Status: "OK",
		Event:  event,
	}
	if err := c.con.WriteJSON(msg); err != nil {
		log.Error("websocketClient.Send > unable to write json: %v", err)
	}
	return nil
}
