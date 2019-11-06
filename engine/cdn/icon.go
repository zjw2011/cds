package cdn

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"io/ioutil"
	"net/http"
	"time"

	"github.com/ovh/cds/sdk"
)

func (s *Service) storeIcon(ctx context.Context, body io.ReadCloser, cdnRequest sdk.CDNRequest) (*sdk.WorkflowNodeRunArtifact, error) {
	if cdnRequest.Icon == nil {
		return nil, fmt.Errorf("icon in cdn request cannot be nil")
	}
	// if len(icon) > sdk.MaxIconSize {
	// 	return sdk.ErrIconBadSize
	// }
	icon := cdnRequest.Icon

	storageDriver, err := s.getDriver(cdnRequest.ProjectKey, sdk.DefaultStorageIntegrationName)
	if err != nil {
		return nil, sdk.WrapError(err, "cannot get driver")
	}

	var buf bytes.Buffer
	tee := io.TeeReader(body, &buf)
	if _, err := storageDriver.Store(ctx, icon, ioutil.NopCloser(tee)); err != nil {
		return nil, sdk.WrapError(err, "Cannot store icon")
	}

	sdk.GoRoutine(context.Background(), "StoreIconMirroring", func(_ context.Context) {
		defer body.Close()
		s.mirroring(icon, &buf)
	})

	//Try 50 times to make the callback
	var callbackErr error
	retry := 50
	uri := fmt.Sprintf("/project/%s/storage/icon/url/callback", cdnRequest.ProjectKey)
	if cdnRequest.Icon.WorkflowID != 0 {
		uri = fmt.Sprintf("/project/%s/workflow/%d/storage/icon/url/callback", cdnRequest.ProjectKey, cdnRequest.Icon.WorkflowID)
	}

	for i := 0; i < retry; i++ {
		ctxt, cancel := context.WithTimeout(ctx, 5*time.Second)
		_, callbackErr = s.Client.PostJSON(ctxt, uri, icon, nil)
		if callbackErr == nil {
			cancel()
			return nil, nil
		}
		cancel()
	}

	return nil, sdk.WrapError(callbackErr, "cannot send icon upload callback")
}

func (s *Service) downloadIcon(ctx context.Context, req *http.Request, cdnRequest sdk.CDNRequest) (io.ReadCloser, error) {
	storageDriver, err := s.getDriver(cdnRequest.ProjectKey, cdnRequest.IntegrationName)
	if err != nil {
		return nil, sdk.WrapError(err, "cannot get driver")
	}

	content, err := storageDriver.Fetch(ctx, cdnRequest.Icon)
	if err == nil {
		return content, nil
	}

	return s.downloadFromMirrors(ctx, cdnRequest.Icon)
}
