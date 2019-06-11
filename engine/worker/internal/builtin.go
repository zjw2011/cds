package internal

import (
	"context"
	"fmt"

	"github.com/ovh/cds/engine/worker/internal/action"
	"github.com/ovh/cds/engine/worker/pkg/workerruntime"
	"github.com/ovh/cds/sdk"
	"github.com/ovh/cds/sdk/log"
)

var mapBuiltinActions = map[string]BuiltInAction{}

func init() {
	mapBuiltinActions[sdk.ArtifactUpload] = action.RunArtifactUpload
	mapBuiltinActions[sdk.ArtifactDownload] = action.RunArtifactDownload
	mapBuiltinActions[sdk.ScriptAction] = action.RunScriptAction
	mapBuiltinActions[sdk.JUnitAction] = action.RunParseJunitTestResultAction
	mapBuiltinActions[sdk.GitCloneAction] = action.RunGitClone
	mapBuiltinActions[sdk.GitTagAction] = action.RunGitTag
	mapBuiltinActions[sdk.ReleaseAction] = action.RunRelease
	mapBuiltinActions[sdk.CheckoutApplicationAction] = action.RunCheckoutApplication
	mapBuiltinActions[sdk.DeployApplicationAction] = action.RunDeployApplication
	mapBuiltinActions[sdk.CoverageAction] = action.RunParseCoverageResultAction
	mapBuiltinActions[sdk.ServeStaticFiles] = action.RunServeStaticFiles
}

func (w *CurrentWorker) runBuiltin(ctx context.Context, a *sdk.Action, params []sdk.Parameter, secrets []sdk.Variable) sdk.Result {
	defer w.drainLogsAndCloseLogger(ctx)

	f, ok := mapBuiltinActions[a.Name]
	if !ok {
		res := sdk.Result{
			Status: sdk.StatusFail,
			Reason: fmt.Sprintf("unknown builtin step: %s", a.Name),
		}
		log.Error("worker.runBuiltin> %v", res.Reason)
		w.SendLog(workerruntime.LevelError, res.Reason)
		return res
	}

	res, err := f(ctx, w, a, params, secrets)
	if err != nil {
		res.Status = sdk.StatusFail
		res.Reason = err.Error()
		log.Error("worker.runBuiltin> %v", err)
		w.SendLog(workerruntime.LevelError, res.Reason)
	}
	return res
}

func (w *CurrentWorker) runGRPCPlugin(ctx context.Context, a *sdk.Action, params []sdk.Parameter) sdk.Result {
	chanRes := make(chan sdk.Result, 1)
	done := make(chan struct{})
	sdk.GoRoutine(ctx, "runGRPCPlugin", func(ctx context.Context) {
		action.RunGRPCPlugin(ctx, a.Name, params, w, chanRes, done)
	})

	select {
	case <-ctx.Done():
		log.Error("CDS Worker execution cancelled: %v", ctx.Err())
		return sdk.Result{
			Status: sdk.StatusFail,
			Reason: "CDS Worker execution cancelled",
		}
	case res := <-chanRes:
		// Useful to wait all logs are send before sending final status and log
		<-done
		return res
	}
}
