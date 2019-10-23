package sdk

import (
	"fmt"
	"net/url"
	"strings"
)

type CDNObjectType string

const (
	CDNArtifactType CDNObjectType = "CDNArtifactType"
	CDNIconType     CDNObjectType = "CDNIconType"
)

type CDNRequest struct {
	Name            string                   `json:"name" yaml:"name"`
	Type            CDNObjectType            `json:"type" yaml:"type"`
	ProjectKey      string                   `json:"project_key,omitempty" yaml:"project_key,omitempty"`
	IntegrationName string                   `json:"integration_name,omitempty" yaml:"integration_name,omitempty"`
	Config          map[string]string        `json:"config,omitempty" yaml:"config,omitempty"`
	Artifact        *WorkflowNodeRunArtifact `json:"artifact,omitempty" yaml:"artifact,omitempty"`
	Icon            *Icon                    `json:"icon,omitempty" yaml:"icon,omitempty"`
}

type Icon struct {
	Filename   string `json:"filename" yaml:"filename"`
	ProjectKey string `json:"project_key" yaml:"project_key"`
	WorkflowID int64  `json:"workflow_id" yaml:"workflow_id"`
}

//GetName returns the name the icon
func (icon *Icon) GetName() string {
	return icon.Filename
}

//GetPath returns the path of the icon
func (icon *Icon) GetPath() string {
	container := fmt.Sprintf("icon-%s", icon.Filename)
	if icon.WorkflowID != 0 {
		container += fmt.Sprintf("-%d", icon.WorkflowID)
	}

	container = strings.Replace(url.QueryEscape(container), "/", "-", -1)
	return container
}
