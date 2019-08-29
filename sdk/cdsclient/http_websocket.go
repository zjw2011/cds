package cdsclient

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"runtime/pprof"
	"strings"
	"time"

	"github.com/gorilla/websocket"

	"github.com/ovh/cds/sdk"
	"github.com/ovh/cds/sdk/log"
)

func (c *client) RequestWebsocket(ctx context.Context, path string, msgToSend <-chan sdk.WebsocketFilter, msgReceived chan<- sdk.WebsocketEvent) error {
	// Checks that current session_token is still valid
	// If not, challenge a new one against the authenticationToken
	if !c.config.HasValidSessionToken() && c.config.BuitinConsumerAuthenticationToken != "" {
		resp, err := c.AuthConsumerSignin(sdk.ConsumerBuiltin, sdk.AuthConsumerSigninRequest{"token": c.config.BuitinConsumerAuthenticationToken})
		if err != nil {
			return err
		}
		c.config.SessionToken = resp.Token
	}

	labels := pprof.Labels("path", path, "method", "GET")
	ctx = pprof.WithLabels(ctx, labels)
	pprof.SetGoroutineLabels(ctx)

	uHost, err := url.Parse(c.config.Host)
	if err != nil {
		return sdk.WrapError(err, "wrong Host configuration")
	}
	urlWebsocket := url.URL{
		Scheme: strings.Replace(uHost.Scheme, "http", "ws", -1),
		Host:   uHost.Host,
		Path:   "/ws",
	}

	headers := make(map[string][]string)
	date := sdk.FormatDateRFC5322(time.Now())
	headers["Date"] = []string{date}
	headers["X-CDS-RemoteTime"] = []string{date}
	auth := "Bearer " + c.config.SessionToken
	headers["Authorization"] = []string{auth}
	con, _, err := websocket.DefaultDialer.Dial(urlWebsocket.String(), headers)
	if err != nil {
		return sdk.WithStack(err)
	}
	defer con.Close()

	// Message to send
	sdk.GoRoutine(ctx, fmt.Sprintf("RequestWebsocket-%s-%s", c.config.User, sdk.UUID()), func(ctx context.Context) {
		for i := range msgToSend {
			if err := con.WriteJSON(i); err != nil {
				log.Error("ws: unable to send message: %v", err)
			}
		}
	})

	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		_, message, err := con.ReadMessage()
		if err != nil {
			log.Error("ws: unable to read message: %v", err)
			continue
		}
		var wsEvent sdk.WebsocketEvent
		if err := json.Unmarshal(message, &wsEvent); err != nil {
			log.Error("ws: unable to unmarshal message: %s : %v", string(message), err)
			continue
		}
		msgReceived <- wsEvent
	}
	return nil
}
