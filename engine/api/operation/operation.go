package operation

import (
	"context"
	"net/http"
	"time"

	"github.com/go-gorp/gorp"

	"github.com/ovh/cds/engine/api/services"
	"github.com/ovh/cds/sdk"
	"github.com/ovh/cds/sdk/log"
)

func Poller(ctx context.Context, db gorp.SqlExecutor, ope *sdk.Operation, loop int) {
	counter := -1
	for {
		counter++
		if counter >= loop {
			return
		}
		time.Sleep(1 * time.Second)
		if err := Get(ctx, db, ope); err != nil {
			log.Error("unable to get repository operation %s: %v", ope.UUID, err)
			continue
		}
		if ope.Status == sdk.OperationStatusDone || ope.Status == sdk.OperationStatusError {
			return
		}
	}
}

// Get repository operation status
func Get(ctx context.Context, db gorp.SqlExecutor, ope *sdk.Operation) error {
	srvs, err := services.LoadAllByType(ctx, db, services.TypeRepositories)
	if err != nil {
		return err
	}
	if _, _, err := services.DoJSONRequest(ctx, db, srvs, http.MethodGet, "/operations/"+ope.UUID, nil, ope); err != nil {
		return err
	}
	return nil
}
