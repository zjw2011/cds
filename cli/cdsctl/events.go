package main

import (
	"context"
	"fmt"
	"github.com/ovh/cds/sdk/cdsclient"
	"io/ioutil"

	"github.com/spf13/cobra"

	"github.com/ovh/cds/cli"
	"github.com/ovh/cds/sdk"
)

var eventsCmd = cli.Command{
	Name:  "events",
	Short: "Listen CDS Events",
}

func events() *cobra.Command {
	return cli.NewCommand(eventsCmd, nil, []*cobra.Command{
		cli.NewCommand(eventsListenCmd, eventsListenRun, nil, withAllCommandModifiers()...),
	})
}

var eventsListenCmd = cli.Command{
	Name:  "listen",
	Short: "Listen CDS events",
}

func eventsListenRun(v cli.Values) error {
	ctx := context.Background()
	chanMessageReceived := make(chan sdk.WebsocketEvent)
	chanMessageToSend := make(chan sdk.WebsocketFilter)

	sdk.GoRoutine(ctx, "EventsListenCmd", func(ctx context.Context) {
		client.EventsListen(ctx, chanMessageToSend, chanMessageReceived)
	})

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case wsEvt := <-chanMessageReceived:
			if wsEvt.Event.EventType == "" {
				continue
			}
			fmt.Printf("%s: %s %s %s\n", wsEvt.Event.EventType, wsEvt.Event.ProjectKey, wsEvt.Event.WorkflowName, wsEvt.Event.Status)
		}
	}
}
